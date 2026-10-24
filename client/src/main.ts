import './style.css';
import {
  info, castsByFid, castsByParent, following, followers, castsByMention, profile, fidByName, appOfCast,
  isFollowing, liked, signerActive, toDate, linkCount, castById, castsByUrl, channelInfo, channelOfUrl,
  type CastMsg, type Channel,
} from './hub';
import { loadKey, saveKey, forgetKey, type Stored } from './store';
// Signing, posting and the Base lookup load on first use, so reading starts with a small script.
const K = () => import('./keys');
const M = () => import('./msg');
const V = () => import('./votes');
const U = () => import('./media');
import { loadConfig, startSignin, resumeSignin, dropPending, waitSignin, qrSvg, isMobile, type Config, type Pending } from './signin';
import { viewLive, stopLive } from './live';

const $view = document.getElementById('view')!;
const $node = document.getElementById('node')!;
const $me = document.getElementById('me')!;

let key: Stored | null = loadKey();
let cfg: Config = { signin: false, appFid: null, defaultFid: null };
const READ_FID = () => Number(localStorage.getItem('readFid') || 0);
const myFid = () => key?.fid || READ_FID();

// ---------- helpers ----------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const h = (html: string) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild as HTMLElement; };
const ago = (d: Date) => {
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
};
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

/** Put "@username" back into the text at the byte positions the protocol stores. */
async function renderText(c: CastMsg) {
  const b = c.data.castAddBody;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const bytes = enc.encode(b.text || '');
  const ms = b.mentions ?? [], ps = b.mentionsPositions ?? [];
  const names = await Promise.all(ms.map((f) => profile(f)));
  let html = '', last = 0;
  ps.forEach((p, i) => {
    html += esc(dec.decode(bytes.slice(last, p)));
    const n = names[i];
    html += `<a class="mention" href="#/u/${n.fid}">@${esc(n.username || `fid:${n.fid}`)}</a>`;
    last = p;
  });
  html += esc(dec.decode(bytes.slice(last)));
  return html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>');
}

/** Profile picture, or the first letter when there is none (or it fails to load). */
function avatar(p: { fid: number; username?: string; display?: string; pfp?: string }) {
  const letter = esc(((p.display || p.username || '?').trim()[0] || '?').toUpperCase());
  return p.pfp
    ? `<span class="pfp" data-l="${letter}"><img src="${esc(p.pfp)}" alt="" loading="lazy"></span>`
    : `<span class="pfp" data-l="${letter}"></span>`;
}
// broken images fall back to the letter (no inline handlers: the CSP forbids them)
document.addEventListener('error', (e) => {
  const t = e.target as HTMLElement;
  if (t.tagName === 'IMG' && t.parentElement?.classList.contains('pfp')) t.remove();
}, true);

// ---------- client filter ----------

const hiddenApps = new Set<number>(JSON.parse(localStorage.getItem('hiddenApps') || '[]'));
const saveHidden = () => localStorage.setItem('hiddenApps', JSON.stringify([...hiddenApps]));
let votersOnly = localStorage.getItem('votersOnly') === '1';

// ---------- node status ----------

/** The gargoyle in the corner shows how your node is doing: awake and watching, squinting while it catches up, asleep while it downloads. */
const MOOD = { awake: 'Your node is awake: in sync', syncing: 'Your node is catching up', asleep: 'Your node is asleep: still downloading the network, or not reachable' };
function mood(m: keyof typeof MOOD) {
  document.documentElement.dataset.node = m;
  document.querySelector('.brand')?.setAttribute('title', MOOD[m]);
}

async function nodeStatus() {
  try {
    const i = await info();
    // Every shard counts, shard 0 included: KEY_ADD and KEY_REMOVE are validated there.
    const delays: number[] = (i.shardInfos ?? []).map((s: any) => Number(s.blockDelay ?? 0));
    const worst = delays.length ? Math.max(...delays) : 0;
    const height = Math.max(0, ...(i.shardInfos ?? []).map((s: any) => Number(s.maxHeight ?? 0)));
    $node.className = 'node ' + (worst < 10 ? 'ok' : 'warn');
    mood(worst < 10 ? 'awake' : 'syncing');
    $node.innerHTML = worst < 10
      ? `<b>${cfg.signin ? 'Node' : 'Your node'}</b> in sync${height ? `, block ${height.toLocaleString('en-US')}` : ''}`
      : `<b>${cfg.signin ? 'Node' : 'Your node'}</b> catching up, ${worst.toLocaleString('en-US')} blocks behind`;
  } catch {
    $node.className = 'node bad';
    mood('asleep');
    $node.innerHTML = '<b>Your node</b> is starting: the first run downloads the network, a few hours';
  }
}

const TAB = {
  home: '<svg viewBox="0 0 24 24"><path d="M4 11l8-6 8 6v8.5H14v-5h-4v5H4z"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="M15.5 15.5L20 20"/></svg>',
  live: '<svg viewBox="0 0 24 24"><path d="M3 12h4l2-5 4 10 2-5h6"/></svg>',
  replies: '<svg viewBox="0 0 24 24"><path d="M4 5.5h16v10H9l-5 4z"/></svg>',
  me: '<svg viewBox="0 0 24 24"><circle cx="12" cy="9" r="3.6"/><path d="M5 20c1-3.6 3.6-5.4 7-5.4s6 1.8 7 5.4"/></svg>',
};
/** Bottom tabs on phones, a left rail on wide screens: the layout people know from Farcaster apps. */
async function renderMe() {
  const f = myFid();
  const tab = (href: string, icon: keyof typeof TAB, label: string) => `<a href="${href}" data-tab="${href}">${TAB[icon]}<span>${label}</span></a>`;
  const items = [tab('#/', 'home', 'Home'), tab('#/search', 'search', 'Search'), tab('#/live', 'live', 'Live')];
  if (key) items.push(tab('#/n', 'replies', 'Replies'));
  if (f) {
    const p = await profile(f);
    items.push(`<a href="#/u/${f}" data-tab="#/u/${f}" class="me-tab">${p.pfp ? `<img src="${esc(p.pfp)}" alt="">` : TAB.me}<span>${esc(p.username ? '@' + p.username : 'Me')}</span></a>`);
  }
  if (!key) items.push(`<a href="#/setup" data-tab="#/setup" class="signin-tab">${TAB.me}<span>Sign in</span></a>`);
  $me.innerHTML = items.join('');
  markTab();
}
function markTab() {
  const h = location.hash || '#/';
  $me.querySelectorAll<HTMLElement>('a').forEach((a) => a.classList.toggle('on', a.dataset.tab === h || (a.dataset.tab === '#/' && (h === '#' || h === ''))));
}

// ---------- cast rendering ----------

const ICON = {
  reply: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5h16v10H9l-5 4z"/></svg>',
  like: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>',
  recast: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h11l-3-3M17 17H6l3 3"/></svg>',
  quote: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h5v5c0 2.5-1.5 4-4 4.5M14 8h5v5c0 2.5-1.5 4-4 4.5"/></svg>',
  share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V4M8 8l4-4 4 4M5 13v6h14v-6"/></svg>',
  delete: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V4.5h4V7M7 7l1 12.5h8L17 7"/></svg>',
};

// Video embeds: files (ours, uploaded to your server) play anywhere; the Farcaster app's own
// streams are HLS (.m3u8), which only Safari plays without an extra library. Elsewhere they stay links.
const VIDEO_RE = /\.(mp4|mov|webm)(\?|$)/i;
const HLS_RE = /\.m3u8(\?|$)/i;
const HLS_OK = !!document.createElement('video').canPlayType('application/vnd.apple.mpegurl');
/** Channel id -> the parentUrl casts actually use, learned from casts we have shown. */
const knownChannels = new Map<string, string>();

async function castEl(c: CastMsg, opts: { showParent?: boolean; nested?: boolean } = {}) {
  const p = await profile(c.data.fid);
  const body = c.data.castAddBody;
  const app = await appOfCast(c);
  const appName = !app ? null : app === c.data.fid ? 'own key' : (await profile(app)).username || `app ${app}`;
  const parent = body.parentCastId;
  const parentName = parent && opts.showParent !== false ? (await profile(parent.fid)).username || `fid:${parent.fid}` : null;
  const images = (body.embeds ?? []).filter((e) => e.url && /\.(png|jpe?g|gif|webp)(\?|$)|imagedelivery\.net/i.test(e.url));
  const videos = (body.embeds ?? []).filter((e) => e.url && !images.includes(e) && (VIDEO_RE.test(e.url) || (HLS_RE.test(e.url) && HLS_OK)));
  // a link already written in the text is not repeated as an embed under it
  const links = (body.embeds ?? []).filter((e) => e.url && !images.includes(e) && !videos.includes(e) && !(body.text || '').includes(e.url));
  const chan = channelOfUrl(body.parentUrl);
  if (chan) knownChannels.set(chan, body.parentUrl!);
  const quoted = opts.nested ? [] : (body.embeds ?? []).filter((e) => e.castId).slice(0, 1);
  const mine = key && c.data.fid === key.fid;

  const el = h(`
    <article class="cast${opts.nested ? ' nested' : ''}" data-app="${app ?? ''}" data-voted="0">
      <a href="#/u/${p.fid}">${avatar(p)}</a>
      <div>
        <div class="head">
          <a class="name" href="#/u/${p.fid}">${esc(p.display || p.username || `fid ${p.fid}`)}</a>
          <span class="handle">@${esc(p.username || String(p.fid))}</span>
          <a class="time" href="#/c/${c.data.fid}/${c.hash}">${ago(toDate(c.data.timestamp))}</a>
          ${chan ? `<a class="chan" href="#/ch/${chan}">/${esc(chan)}</a>` : ''}
          ${appName ? `<span class="via" title="The app that signed this cast (app fid ${app})">via ${esc(appName)}</span>` : ''}
        </div>
        ${parentName ? `<div class="reply-to">replying to <a href="#/c/${parent!.fid}/${parent!.hash}">@${esc(parentName)}</a></div>` : ''}
        <div class="text">${await renderText(c)}</div>
        ${images.map((e) => `<img class="embed-img" src="${esc(e.url!)}" alt="" loading="lazy">`).join('')}
        ${videos.map((e) => `<video class="embed-vid" src="${esc(e.url!)}" controls playsinline preload="metadata"></video>`).join('')}
        ${links.map((e) => `<a class="embed" href="${esc(e.url!)}" target="_blank" rel="noreferrer">${esc(e.url!)}</a>`).join('')}
        <div class="quoted-slot"></div>
        ${opts.nested ? '' : `<div class="actions">
          <button data-a="reply" aria-label="Reply" title="Reply">${ICON.reply}</button>
          <button data-a="like" aria-label="Like" title="Like">${ICON.like}</button>
          <button data-a="recast" aria-label="Recast" title="Recast">${ICON.recast}</button>
          <button data-a="quote" aria-label="Quote" title="Quote">${ICON.quote}</button>
          <button data-a="share" aria-label="Share" title="Copy link">${ICON.share}</button>
          ${mine ? `<button data-a="delete" aria-label="Delete" title="Delete">${ICON.delete}</button>` : ''}
          <button data-a="inspect" class="inspect" aria-label="Inspect the protocol message" title="Inspect the protocol message">{ }</button>
        </div>
        <div class="slot"></div>`}
      </div>
    </article>`);

  const target = { fid: c.data.fid, hash: c.hash };
  // The "voted" badge arrives after the cast is on screen: it needs a lookup on Base.
  V().then((m) => m.voted(c.data.fid)).then((v) => {
    if (!v) return;
    el.dataset.voted = '1';
    el.querySelector('.handle')?.insertAdjacentHTML('afterend', '<span class="voted" title="Accepted the social contract in the Farcaster network vote (VOTE NFT on Base, token id = fid)">voted</span>');
    el.dispatchEvent(new CustomEvent('voted', { bubbles: true }));
  }).catch(() => { /* Base not reachable: no badge */ });
  for (const q of quoted) {
    const qc = await castById(q.castId!.fid, q.castId!.hash);
    const slot = el.querySelector('.quoted-slot')!;
    if (!qc) { slot.innerHTML = `<a class="quoted missing" href="#/c/${q.castId!.fid}/${q.castId!.hash}">Quoted cast not on your node</a>`; continue; }
    const card = h(`<div class="quoted" role="link" tabindex="0"></div>`);
    const open = () => (location.hash = `#/c/${qc.data.fid}/${qc.hash}`);
    card.addEventListener('click', (ev) => { if (!(ev.target as HTMLElement).closest('a')) open(); });
    card.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') open(); });
    card.append(await castEl(qc, { nested: true, showParent: false }));
    slot.append(card);
  }
  if (opts.nested) return el;
  const likeBtn = el.querySelector<HTMLButtonElement>('[data-a=like]')!;
  if (key) liked(key.fid, target).then((on) => on && likeBtn.classList.add('on'));

  el.querySelector('.actions')!.addEventListener('click', async (ev) => {
    const b = (ev.target as HTMLElement).closest('button');
    if (!b) return;
    if (b.dataset.a === 'inspect') {
      const slot = el.querySelector('.slot')!;
      if (slot.querySelector('.inspect-panel')) { slot.innerHTML = ''; return; }
      const signed = new Date(toDate(c.data.timestamp)).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
      slot.innerHTML = `
        <div class="inspect-panel">
          <div class="kv">
            <b>Message</b><span>CAST_ADD from fid ${c.data.fid}, Farcaster time ${c.data.timestamp} (${signed})</span>
            <b>Hash</b><span class="mono">${esc(c.hash)} (BLAKE3)</span>
            <b>Signer</b><span class="mono">${esc(c.signer)}</span>
            <b>Signed by app</b><span>${app ? `fid ${app}${appName ? ` (${esc(appName)})` : ''}, from the key's SignedKeyRequest` : 'unknown'}</span>
            <b>Signature</b><span class="mono">${esc(String((c as any).signature ?? '').slice(0, 44))}… (Ed25519)</span>
          </div>
          <p class="muted">Your node stored this only after checking the hash, the Ed25519 signature, and that the signer is an active key of fid ${c.data.fid}. <a href="/v1/castById?fid=${c.data.fid}&hash=${esc(c.hash)}" target="_blank" rel="noreferrer">Raw JSON from your node</a></p>
        </div>`;
      return;
    }
    if (b.dataset.a === 'share') { await shareCast(c, p.username, b); return; }
    if (!key) { location.hash = '#/setup'; return; }
    const a = b.dataset.a;
    try {
      if (a === 'reply') {
        const slot = el.querySelector('.slot')!;
        if (!slot.childElementCount) slot.append(composer(target, () => (slot.innerHTML = '')));
      } else if (a === 'quote') {
        const slot = el.querySelector('.slot')!;
        if (!slot.childElementCount) slot.append(composer(undefined, () => (slot.innerHTML = ''), target));
      } else if (a === 'like') {
        const on = !b.classList.contains('on');
        await (await M()).react(key, 'like', target, on);
        b.classList.toggle('on', on);
      } else if (a === 'recast') {
        await (await M()).react(key, 'recast', target, true);
        b.classList.add('on');
      } else if (a === 'delete' && confirm('Delete this cast?')) {
        await (await M()).deleteCast(key, c.hash);
        el.remove();
      }
    } catch (e) {
      alert((e as Error).message);
    }
  });
  return el;
}

/** A short message at the bottom of the screen. */
function toast(text: string) {
  document.querySelector('.toast')?.remove();
  const t = h(`<div class="toast" role="status">${esc(text)}</div>`);
  document.body.append(t);
  setTimeout(() => t.remove(), 1800);
}

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back below */ }
  const ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.append(ta); ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  return ok;
}

/** Link to a cast on this client. Opens for anyone, signed in or not. */
async function shareCast(c: CastMsg, username: string | undefined, b: HTMLElement) {
  // /c/... links carry a preview of the cast when the server renders them (server/), else a plain hash link.
  const url = cfg.castLinks ? `${location.origin}/c/${c.data.fid}/${c.hash}` : `${location.origin}/#/c/${c.data.fid}/${c.hash}`;
  const text = c.data.castAddBody.text.slice(0, 120);
  if (isMobile() && navigator.share) {
    try { await navigator.share({ url, title: `@${username ?? c.data.fid} on Farcaster`, text }); return; }
    catch (e) { if ((e as Error).name === 'AbortError') return; /* no share sheet: copy instead */ }
  }
  if (await copyText(url)) {
    b.classList.add('on'); toast('Link copied');
    setTimeout(() => b.classList.remove('on'), 1500);
  } else {
    prompt('Copy this link', url);
  }
}

const TOOL = {
  media: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M20.5 15.5l-5-4.5-8.5 8"/></svg>',
};

type Att = { file: File; preview: string; kind: 'image' | 'video'; url?: string; failed?: boolean; el: HTMLElement };

/**
 * Write a cast. Top-level casts can go to a channel; any cast can carry images or video,
 * uploaded to your own server. Replies stay in the thread they answer.
 */
function composer(parent?: { fid: number; hash: string }, done?: () => void, quote?: { fid: number; hash: string }, channel?: Channel) {
  const small = !!(parent || quote);
  const canChannel = !parent && !!cfg.channels;
  const room = 2 - (quote ? 1 : 0);
  const el = h(`
    <div class="compose ${small ? 'is-reply' : ''}">
      <div class="chan-row" ${channel ? '' : 'hidden'}><span class="slash">/</span><input aria-label="Channel" placeholder="channel" autocapitalize="off" autocomplete="off" spellcheck="false" value="${esc(channel?.id ?? '')}"><span class="st"></span><button class="x" title="No channel" aria-label="No channel">×</button></div>
      <textarea rows="${small ? 2 : 3}" maxlength="1024" placeholder="${parent ? 'Write a reply' : quote ? 'Add your take' : channel ? `Write in /${esc(channel.id)}` : 'Write a cast'}"></textarea>
      <div class="atts"></div>
      <div class="row">
        <div class="tools">
          ${cfg.media ? `<button class="tool" data-t="media" title="Add images or video (stored on your server)" aria-label="Add images or video">${TOOL.media}</button><input type="file" accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime,video/webm" multiple hidden>` : ''}
          ${canChannel ? `<button class="tool ${channel ? 'on' : ''}" data-t="chan" title="Post to a channel" aria-label="Post to a channel">/</button>` : ''}
        </div>
        <span class="count"></span><button class="btn primary send" disabled>${parent ? 'Reply' : quote ? 'Quote' : 'Cast'}</button>
      </div>
      <div class="err"></div>
    </div>`);
  const ta = el.querySelector('textarea')!, btn = el.querySelector<HTMLButtonElement>('.send')!, err = el.querySelector('.err')!, count = el.querySelector('.count')!;
  const attsEl = el.querySelector('.atts')!, fileIn = el.querySelector<HTMLInputElement>('input[type=file]');
  const chanRow = el.querySelector<HTMLElement>('.chan-row')!, chanIn = chanRow.querySelector('input')!, chanSt = chanRow.querySelector<HTMLElement>('.st')!;
  const mediaBtn = el.querySelector<HTMLButtonElement>('[data-t=media]'), chanBtn = el.querySelector<HTMLButtonElement>('[data-t=chan]');
  let atts: Att[] = [];
  let chan: Channel | null = channel ?? null;
  let chanLookup: Promise<void> = Promise.resolve();

  const uploading = () => atts.some((a) => !a.url && !a.failed);
  const refresh = () => {
    const n = new TextEncoder().encode(ta.value).length;
    count.textContent = uploading() ? 'Uploading…' : n > 800 ? `${1024 - n} left` : '';
    btn.disabled = uploading() || atts.some((a) => a.failed) || (!ta.value.trim() && !atts.length);
    if (mediaBtn) mediaBtn.disabled = atts.length >= room;
  };
  ta.addEventListener('input', () => { refresh(); ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; });

  // ---- images and video ----
  mediaBtn?.addEventListener('click', () => fileIn!.click());
  fileIn?.addEventListener('change', async () => {
    const files = [...(fileIn.files ?? [])];
    fileIn.value = '';
    if (!key) { location.hash = '#/setup'; return; }
    err.textContent = '';
    const { upload, IMAGE_TYPES, VIDEO_TYPES } = await U();
    for (const file of files) {
      if (atts.length >= room) { err.textContent = `A cast can carry ${room === 1 ? 'one attachment next to a quote' : 'two attachments'}.`; break; }
      const kind = IMAGE_TYPES.includes(file.type) ? 'image' : VIDEO_TYPES.includes(file.type) ? 'video' : null;
      if (!kind) { err.textContent = `${file.name}: only images (JPEG, PNG, GIF, WebP) and video (MP4, MOV, WebM).`; continue; }
      const preview = URL.createObjectURL(file);
      const media = kind === 'image' ? `<img alt="" src="${preview}">` : `<video muted playsinline preload="metadata" src="${preview}"></video><span class="tag">video</span>`;
      const tile = h(`<div class="att">${media}<span class="bar"></span><button class="rm" title="Remove" aria-label="Remove">×</button></div>`);
      tile.querySelector<HTMLElement>('.bar')!.style.width = '4%';
      const a: Att = { file, preview, kind, el: tile };
      atts.push(a); attsEl.append(tile); refresh();
      tile.querySelector('.rm')!.addEventListener('click', () => { atts = atts.filter((x) => x !== a); tile.remove(); URL.revokeObjectURL(preview); refresh(); });
      const bar = tile.querySelector<HTMLElement>('.bar')!;
      upload(key, file, (s) => (bar.style.width = `${Math.max(4, Math.round(s * 100))}%`))
        .then((r) => { a.url = r.url; tile.classList.add('done'); })
        .catch((e) => { a.failed = true; tile.classList.add('failed'); if (atts.includes(a)) err.textContent = (e as Error).message; })
        .finally(refresh);
    }
  });

  // ---- channel ----
  const showChan = (c: Channel | null, msg = '', cls = '') => {
    chan = c;
    chanSt.className = 'st ' + cls;
    chanSt.textContent = msg;
    chanBtn?.classList.toggle('on', !chanRow.hidden);
  };
  let t: number | undefined;
  chanIn.addEventListener('input', () => {
    clearTimeout(t);
    const id = chanIn.value.trim().replace(/^\//, '').toLowerCase();
    if (!id) { showChan(null); return; }
    showChan(null, 'looking up…');
    t = window.setTimeout(() => {
      chanLookup = channelInfo(id).then((c) => {
        if (chanIn.value.trim().replace(/^\//, '').toLowerCase() !== id) return;
        if (c.publicCasting) showChan(c, `✓ ${c.name || c.id}`, 'ok');
        else showChan(c, 'members only: the Farcaster app may hide casts from non-members in this channel', 'warn');
      }).catch((e) => showChan(null, (e as Error).message, 'bad'));
    }, 350);
  });
  if (channel) showChan(channel, `✓ ${channel.name || channel.id}`, 'ok');
  chanBtn?.addEventListener('click', () => {
    chanRow.hidden = !chanRow.hidden;
    if (!chanRow.hidden) chanIn.focus(); else { chanIn.value = ''; showChan(null); }
    chanBtn.classList.toggle('on', !chanRow.hidden);
  });
  chanRow.querySelector('.x')!.addEventListener('click', () => { chanRow.hidden = true; chanIn.value = ''; showChan(null); chanBtn?.classList.remove('on'); });

  btn.addEventListener('click', async () => {
    if (!key || btn.disabled) return;
    btn.disabled = true; err.textContent = '';
    try {
      await chanLookup;
      if (!chanRow.hidden && chanIn.value.trim() && !chan) throw new Error('Pick a channel that exists, or clear it.');
      await (await M()).cast(key, ta.value, parent, quote, { media: atts.map((a) => a.url!), channelUrl: chanRow.hidden ? undefined : chan?.url });
      ta.value = '';
      for (const a of atts) URL.revokeObjectURL(a.preview);
      atts = []; attsEl.innerHTML = '';
      err.innerHTML = `<span class="muted">Sent${chan && !chanRow.hidden ? ` to /${esc(chan.id)}` : ''}. Your node relayed it to the network; it appears once a validator includes it, usually within seconds.</span>`;
      refresh();
      done?.();
    } catch (e) {
      err.textContent = (e as Error).message;
      refresh();
    }
  });
  return el;
}

// ---------- views ----------

/** An empty feed is a dead end. Offer a few well-known accounts to follow, one tap each. */
const STARTERS = ['dwr', 'v', 'balajis.eth', 'vitalik.eth', 'horsefacts.eth', 'jessepollak', 'linda', 'ted'];
async function starter() {
  const box = h(`<section class="starter"><h2>Your feed is empty</h2><p class="muted">Follow a few people to fill it. You can unfollow any time.</p><div class="people"></div></section>`);
  const people = box.querySelector('.people')!;
  for (const name of STARTERS) {
    const fid = await fidByName(name).catch(() => null);
    if (!fid) continue;
    const p = await profile(fid);
    const row = h(`<div class="person"><a href="#/u/${fid}">${avatar(p)}</a><div><a class="name" href="#/u/${fid}">${esc(p.display || p.username || 'fid ' + fid)}</a><span class="handle">@${esc(p.username || String(fid))}</span></div><button class="btn primary sm">Follow</button></div>`);
    const b = row.querySelector('button')!;
    if (!key) { b.textContent = 'View'; b.classList.remove('primary'); b.onclick = () => (location.hash = `#/u/${fid}`); }
    else b.onclick = async () => {
      b.disabled = true;
      try { await (await M()).follow(key!, fid, true); b.textContent = 'Following'; b.classList.remove('primary'); }
      catch (e) { toast((e as Error).message); b.disabled = false; }
    };
    people.append(row);
  }
  const done = h('<p><a class="btn" href="#/">Show my feed</a></p>');
  done.querySelector('a')!.addEventListener('click', (e) => { e.preventDefault(); route(); });
  box.append(done);
  return box;
}

async function viewFeed() {
  const fid = myFid();
  const guest = !fid && !!cfg.defaultFid;
  if (!fid && !guest) return viewSetup();
  $view.innerHTML = '';
  if (guest) $view.append(h(`<div class="guest"><div><b>You are reading the town square.</b><span class="muted">Sign in to see the people you follow, and to post.</span></div><a class="btn primary" href="#/setup">Sign in</a></div>`));
  if (key) $view.append(composer());
  const filter = h(`<div class="sources"><button class="chip voters ${votersOnly ? '' : 'off'}" aria-pressed="${votersOnly}" title="Only show people who voted">Voters only</button><span class="sources-label">Apps in your feed</span><div class="chips"></div></div>`);
  const list = h('<section></section>');
  $view.append(filter, list);
  list.innerHTML = '<div class="center">Reading your feed from your node…</div>';

  const fids = guest ? await following(cfg.defaultFid!, 150) : [fid, ...(await following(fid, 150))];
  const batches = await pool(fids, 12, (f) => castsByFid(f, 4).catch(() => []));
  const casts = batches.flat().sort((a, b) => b.data.timestamp - a.data.timestamp).slice(0, 120);
  list.innerHTML = '';
  if (!casts.length) { list.append(await starter()); return; }

  const counts = new Map<number, number>();
  const els = await pool(casts, 8, (c) => castEl(c));
  for (const el of els) {
    list.append(el);
    const app = Number(el.dataset.app || 0);
    if (app) counts.set(app, (counts.get(app) || 0) + 1);
  }
  const apply = () => list.querySelectorAll<HTMLElement>(':scope > .cast').forEach((el) => {
    const hide = hiddenApps.has(Number(el.dataset.app || 0)) || (votersOnly && el.dataset.voted !== '1');
    el.style.display = hide ? 'none' : '';
  });
  list.addEventListener('voted', () => { if (votersOnly) apply(); });
  const vchip = filter.querySelector<HTMLButtonElement>('.voters')!;
  vchip.addEventListener('click', () => {
    votersOnly = !votersOnly; localStorage.setItem('votersOnly', votersOnly ? '1' : '0');
    vchip.classList.toggle('off', !votersOnly); vchip.setAttribute('aria-pressed', String(votersOnly)); apply();
  });
  const chips = filter.querySelector('.chips')!;
  for (const [app, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    const name = app === fid || (key && app === cfg.appFid) ? 'townhall' : (await profile(app)).username || `app ${app}`;
    const chip = h(`<button class="chip ${hiddenApps.has(app) ? 'off' : ''}" aria-pressed="${!hiddenApps.has(app)}" title="Show or hide casts signed by ${esc(name)}">${esc(name)} <span>${n}</span></button>`);
    chip.addEventListener('click', () => {
      hiddenApps.has(app) ? hiddenApps.delete(app) : hiddenApps.add(app);
      chip.classList.toggle('off'); chip.setAttribute('aria-pressed', String(!hiddenApps.has(app))); saveHidden(); apply();
    });
    chips.append(chip);
  }
  apply();
}

async function viewProfile(fid: number) {
  const p = await profile(fid);
  $view.innerHTML = '';
  const head = h(`
    <header class="profile">
      ${avatar(p)}
      <div class="who"><h1>${esc(p.display || p.username || `fid ${fid}`)}</h1><div class="muted">@${esc(p.username || '')}, fid ${fid}</div></div>
      <div class="follow"></div>
      ${p.bio ? `<p class="bio">${esc(p.bio)}</p>` : ''}
      <div class="stats muted"><span data-s="following">… following</span><span data-s="followers">… followers</span><span class="mutual" hidden>Follows you</span></div>
    </header>`);
  $view.append(head);
  // counted straight from your node's link store
  const fmt = (c: { n: number; more: boolean }) => (c.n >= 1000 ? `${(c.n / 1000).toFixed(c.n >= 10_000 ? 0 : 1).replace(/\.0$/, '')}K` : String(c.n)) + (c.more ? '+' : '');
  const showFollowing = (c: { n: number; more: boolean }) => (head.querySelector('[data-s=following]')!.innerHTML = `<b>${fmt(c)}</b> following`);
  const showFollowers = (c: { n: number; more: boolean }) => (head.querySelector('[data-s=followers]')!.innerHTML = `<b>${fmt(c)}</b> follower${c.n === 1 && !c.more ? '' : 's'}`);
  linkCount('following', fid, showFollowing).then(showFollowing).catch(() => {});
  linkCount('followers', fid, showFollowers).then(showFollowers).catch(() => {});
  if (fid === myFid()) head.querySelector('.stats')!.insertAdjacentHTML('afterend', `<p><a class="btn sm" href="#/settings">Settings</a>${key ? '' : ' <span class="muted">reading only</span>'}</p>`);
  if (key && fid !== key.fid) isFollowing(fid, key.fid).then((y) => { if (y) head.querySelector<HTMLElement>('.mutual')!.hidden = false; });
  if (key && fid !== key.fid) {
    let on = await isFollowing(key.fid, fid);
    const b = h(`<button class="btn ${on ? '' : 'primary'}">${on ? 'Following' : 'Follow'}</button>`) as HTMLButtonElement;
    b.addEventListener('click', async () => {
      b.disabled = true;
      try { await (await M()).follow(key!, fid, !on); on = !on; b.textContent = on ? 'Following' : 'Follow'; b.classList.toggle('primary', !on); }
      catch (e) { alert((e as Error).message); }
      b.disabled = false;
    });
    head.querySelector('.follow')!.append(b);
  }
  const list = h('<section></section>');
  $view.append(list);
  for (const c of await castsByFid(fid, 30)) list.append(await castEl(c));
}

async function viewThread(fid: number, hash: string) {
  $view.innerHTML = '<div class="center">Loading…</div>';
  const r = await fetch(`/v1/castById?fid=${fid}&hash=${hash}`);
  if (!r.ok) { $view.innerHTML = '<div class="center">Cast not found on your node (yet).</div>'; return; }
  const root: CastMsg = await r.json();
  $view.innerHTML = '';
  $view.append(await castEl(root));
  const replies = (await castsByParent(fid, hash)).sort((a, b) => a.data.timestamp - b.data.timestamp);
  const wrap = h('<section class="replies"></section>');
  for (const c of replies) wrap.append(await castEl(c, { showParent: false }));
  $view.append(wrap);
}

/**
 * A channel: every cast whose parentUrl is the channel's URL, read from your node.
 * The URL comes from casts already seen, else from the channel lookup on your server.
 */
async function viewChannel(id: string) {
  id = id.toLowerCase();
  $view.innerHTML = '<div class="center">Reading the channel from your node…</div>';
  const info = await channelInfo(id).catch(() => null);
  const url = info?.url ?? knownChannels.get(id);
  if (!url) { $view.innerHTML = `<div class="center">Could not find /${esc(id)}.</div>`; return; }
  const casts = await castsByUrl(url, 50);
  $view.innerHTML = '';
  $view.append(h(`<header class="chan-head">${info?.imageUrl ? `<img src="${esc(info.imageUrl)}" alt="">` : ''}<div><h1>/${esc(id)}</h1>${info?.description ? `<p>${esc(info.description)}</p>` : ''}</div></header>`));
  if (key) $view.append(composer(undefined, undefined, undefined, info ?? { id, name: id, url, imageUrl: null, description: '', publicCasting: true }));
  const list = h('<section></section>');
  $view.append(list);
  if (!casts.length) { list.innerHTML = '<div class="center">No casts in this channel on your node yet.</div>'; return; }
  for (const el of await pool(casts, 8, (c) => castEl(c))) list.append(el);
}

/** Replies and mentions. By default only from mutuals: people you follow who follow you back. */
async function viewReplies() {
  const fid = myFid();
  if (!fid) return viewSetup();
  const everyone = localStorage.getItem('repliesEveryone') === '1';
  $view.innerHTML = '';
  const head = h(`<div class="sources"><span class="sources-label">Replies and mentions from</span><div class="chips seg">
    <button class="chip ${everyone ? 'off' : ''}" data-v="0">mutuals</button><button class="chip ${everyone ? '' : 'off'}" data-v="1">everyone</button></div></div>`);
  head.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-v]');
    if (b) { localStorage.setItem('repliesEveryone', b.dataset.v!); viewReplies(); }
  });
  const list = h('<section><div class="center">Reading replies from your node…</div></section>');
  $view.append(head, list);

  const [mine, mentions, outs, ins] = await Promise.all([
    castsByFid(fid, 25), castsByMention(fid, 50).catch(() => []),
    everyone ? Promise.resolve([]) : following(fid, 3000), everyone ? Promise.resolve([]) : followers(fid, 3000),
  ]);
  const replies = (await pool(mine, 6, (c) => castsByParent(fid, c.hash).catch(() => []))).flat();
  const back = new Set(ins);
  const mutual = new Set(outs.filter((f) => back.has(f)));
  const seen = new Set<string>();
  const items = [...replies, ...mentions]
    .filter((c) => c.data.fid !== fid && (everyone || mutual.has(c.data.fid)))
    .filter((c) => !seen.has(c.hash) && seen.add(c.hash))
    .sort((a, b) => b.data.timestamp - a.data.timestamp)
    .slice(0, 60);
  list.innerHTML = items.length ? '' : `<div class="center">${everyone ? 'No replies or mentions yet.' : 'Nothing from mutuals yet. Quiet is fine.'}</div>`;
  for (const el of await pool(items, 8, (c) => castEl(c))) list.append(el);
}

let pendingStop = { stop: false };

function signinCard() {
  const si = h(`
    <section class="option main">
      <h2>Sign in with Farcaster</h2>
      <p class="muted">Approve townhall in the Farcaster app. No recovery phrase. The key townhall posts with is made in this browser and stays here.</p>
      <div class="row"><button class="btn primary" data-a="go">Sign in with Farcaster</button></div>
      <div class="qr"></div>
      <div class="status muted"></div>
      <div class="err"></div>
    </section>`);
  const go = si.querySelector<HTMLButtonElement>('[data-a=go]')!, qr = si.querySelector<HTMLElement>('.qr')!;
  const status = si.querySelector<HTMLElement>('.status')!, err = si.querySelector<HTMLElement>('.err')!;
  const run = async (p: Pending) => {
    go.hidden = true; err.textContent = '';
    if (isMobile()) {
      qr.innerHTML = `<a class="btn primary" href="${esc(p.deeplinkUrl)}">Open the Farcaster app</a>`;
      status.textContent = 'Approve townhall there, then come back to this page.';
    } else {
      qr.innerHTML = `<div class="qrbox">${qrSvg(p.deeplinkUrl)}</div><p class="muted">Scan with your phone camera and approve in the Farcaster app. <a href="${esc(p.deeplinkUrl)}" target="_blank" rel="noreferrer">Open link</a></p>`;
      status.textContent = 'Waiting for approval…';
    }
    pendingStop.stop = true; pendingStop = { stop: false };
    try {
      const stored = await waitSignin(p, (s) => {
        if (s === 'approved') { qr.innerHTML = ''; status.textContent = 'Approved. The Farcaster app is adding the key to your account…'; }
      }, pendingStop);
      qr.innerHTML = '';
      status.textContent = 'Key added. Waiting for the node to see it…';
      saveKey(stored);
      localStorage.setItem('readFid', String(stored.fid));
      key = stored;
      for (let i = 0; i < 60 && !(await signerActive(stored.fid, stored.pub).catch(() => false)); i++) await new Promise((r) => setTimeout(r, 5000));
      renderMe();
      location.hash = '#/';
      route();
    } catch (e) {
      if ((e as Error).message === 'cancelled') return;
      err.textContent = (e as Error).message; go.hidden = false;
    }
  };
  go.addEventListener('click', async () => {
    go.disabled = true;
    try { await run(await startSignin()); } catch (e) { err.textContent = (e as Error).message; }
    go.disabled = false;
  });
  const p = resumeSignin();
  if (p) run(p);
  else dropPending();
  return si;
}

function viewSetup() {
  $view.innerHTML = '';
  // Read-only: just a username
  const ro = h(`
    <section class="option">
      <h2>Just read</h2>
      <p class="muted">See your feed as your node sees it. Nothing to sign.</p>
      <div class="field"><input type="text" placeholder="Your username" autocapitalize="off" spellcheck="false"><button class="btn">Open feed</button></div>
      <div class="err"></div>
    </section>`);
  ro.querySelector('button')!.addEventListener('click', async () => {
    const v = ro.querySelector('input')!.value.trim();
    const fid = /^\d+$/.test(v) ? Number(v) : await fidByName(v);
    if (!fid) { ro.querySelector('.err')!.textContent = 'Username not found on your node.'; return; }
    localStorage.setItem('readFid', String(fid));
    route();
  });

  // Write: seed phrase -> app key with a gasless KEY_ADD message, no transaction (self-hosted only)
  const w = h(`
    <section class="option">
      <h2>Your keys</h2>
      <p class="muted">Paste the recovery phrase of the account you want to use. It signs one message that gives this client its own key, and then it's erased from the page. No transaction, no gas.</p>
      <p class="warnbox">Use a test account. A recovery phrase controls the whole account: only paste it into software you run yourself or from people you trust.</p>
      <textarea placeholder="12 or 24 words" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Recovery phrase"></textarea>
      <div class="row"><button class="btn primary" data-a="add">Connect</button></div>
      <ol class="progress" hidden></ol>
      <div class="err"></div>
      <details class="adv-info"><summary>What happens when I press Connect?</summary>
        <p class="muted">Your phrase finds your account (it never leaves this browser). The page makes a new key for this client, your account signs a KEY_ADD that allows it to post, and your node adds it. Then the phrase is cleared and only the new key is kept here. You can revoke it any time in Settings.</p>
      </details>
    </section>`);
  const ta = w.querySelector('textarea')!, err = w.querySelector('.err')!, prog = w.querySelector<HTMLOListElement>('.progress')!;
  const addBtn = w.querySelector<HTMLButtonElement>('[data-a=add]')!;
  const stepTo = (text: string, state: 'run' | 'done' = 'run') => {
    prog.hidden = false;
    const last = prog.lastElementChild as HTMLElement | null;
    if (last && last.dataset.s === 'run') last.dataset.s = 'done';
    if (state === 'done' && last && last.textContent === text) { last.dataset.s = 'done'; return; }
    prog.insertAdjacentHTML('beforeend', `<li data-s="${state}">${esc(text)}</li>`);
  };
  addBtn.addEventListener('click', async () => {
    err.textContent = ''; prog.innerHTML = ''; addBtn.disabled = true;
    try {
      stepTo('Finding your account');
      const k = await K();
      const r = await k.inspectSeed(ta.value);
      if (!r.fid) throw new Error('No Farcaster account belongs to this phrase. Check the words, or use the phrase of the account itself (not of another wallet).');
      const p = await profile(r.fid);
      prog.lastElementChild!.textContent = `Found @${p.username || 'fid ' + r.fid}`;
      stepTo('Giving this client its own key');
      const { stored } = await k.addAppKey(ta.value, () => {});
      ta.value = '';
      stepTo('Done. Opening your feed', 'done');
      key = stored;
      localStorage.setItem('readFid', String(stored.fid));
      renderMe();
      location.hash = '#/';
      route();
    } catch (e) {
      const m = (e as Error).message.split('\n')[0];
      err.textContent = /mnemonic/i.test(m) ? 'Those words are not a valid recovery phrase. It should be 12 or 24 words separated by spaces.' : m;
      prog.querySelectorAll('[data-s=run]').forEach((li) => ((li as HTMLElement).dataset.s = 'fail'));
      addBtn.disabled = false;
    }
  });

  if (cfg.signin) {
    // Two ways in: through the app you already use, or with your own keys.
    const choice = h(`
      <section class="choice" role="group" aria-label="How to sign in">
        <button class="pick" data-choice="app">
          <b>Sign in with the Farcaster app</b>
          <span>Approve townhall in the app you already use. No recovery phrase.</span>
        </button>
        <button class="pick" data-choice="keys">
          <b>Use your own keys</b>
          <span>Welcome to freedom. Your recovery phrase signs townhall's key directly, with no app in between.</span>
        </button>
      </section>`);
    const slot = h('<div class="choice-slot"></div>');
    const app = signinCard();
    const pick = (which: string) => {
      choice.querySelectorAll<HTMLElement>('.pick').forEach((x) => x.classList.toggle('on', x.dataset.choice === which));
      slot.replaceChildren(which === 'app' ? app : w);
    };
    choice.addEventListener('click', (ev) => {
      const b = (ev.target as HTMLElement).closest<HTMLElement>('.pick');
      if (b) pick(b.dataset.choice!);
    });
    $view.append(h('<div class="hero"><h1>No app can ban you.</h1><p>Farcaster, read from a real node. Sign in the easy way, or hold your own keys.</p></div>'), choice, slot, ro);
    if (resumeSignin()) pick('app');
  } else {
    // Self-hosted without the sign-in service: your own keys; the Farcaster app is one more command away.
    const more = h(`
      <details class="adv">
        <summary>Rather sign in with the Farcaster app, without a phrase?</summary>
        <p class="muted">A sign-in request names the app asking for the key, and the app is a Farcaster account. Give your server a spare account to act as the app, and this page will offer the Farcaster app as a way in:</p>
        <pre class="cmd">ssh -t root@YOUR_IP 'curl -fsSL https://raw.githubusercontent.com/townhall-fc/townhall/main/install/signin.sh | IMPORT=1 bash'</pre>
        <p class="muted"><a href="https://townhallfc.xyz/#signin" target="_blank" rel="noreferrer">How it works</a></p>
      </details>`);
    w.append(more);
    $view.append(h('<div class="hero"><h1>Farcaster, read from your own node.</h1><p>Every cast here comes from the copy of the network on your server. Posts are signed in this browser with a key that belongs to you.</p></div>'), w, ro);
  }
}

function viewSearch(initial = '') {
  $view.innerHTML = '';
  const box = h(`
    <section class="option main">
      <h2>Find someone or a channel</h2>
      <p class="muted">Type a username (dwr, balajis.eth), an FID, or a channel with a slash (/dev). Your node looks up people; channel names come from the Farcaster channel list.</p>
      <form class="field"><input type="search" placeholder="username, FID or /channel" autocapitalize="off" autocorrect="off" spellcheck="false"><button class="btn primary">Find</button></form>
      <div class="err"></div>
    </section>`);
  const input = box.querySelector('input')!, err = box.querySelector('.err')!;
  const go = async () => {
    const raw = input.value.trim().toLowerCase();
    if (raw.startsWith('/') && raw.length > 1) { location.hash = `#/ch/${encodeURIComponent(raw.slice(1))}`; return; }
    const v = raw.replace(/^@/, '');
    if (!v) return;
    err.textContent = '';
    const fid = /^\d+$/.test(v) ? Number(v) : await fidByName(v);
    if (!fid) { err.textContent = `No account named "${v}" on your node. Check the spelling; names ending in .eth need the .eth.`; return; }
    location.hash = `#/u/${fid}`;
  };
  box.querySelector('form')!.addEventListener('submit', (e) => { e.preventDefault(); go(); });
  $view.append(box);
  input.value = initial;
  input.focus();
  if (initial) go();
}

function viewSettings() {
  $view.innerHTML = '';
  const s = h(`
    <div class="card">
      <h2>Settings</h2>
      <div class="kv">
        <b>Account</b><span>${myFid() ? `fid ${myFid()}` : 'none'}</span>
        <b>App key</b><span>${key ? key.pub : 'none (read-only)'}</span>
        <b>Node</b><span>${location.origin}/v1 → your Snapchain read node</span>
      </div>
      <div class="row">
        ${key ? '<button class="btn" data-a="revoke">Revoke this key on the network</button><button class="btn" data-a="forget">Remove from this browser only</button>' : '<button class="btn primary" data-a="connect">Connect account</button>'}
        <button class="btn" data-a="reset">Sign out</button>
      </div>
      <p class="muted">Revoking sends a KEY_REMOVE signed by the key itself, so it stops working everywhere. Removing it from this browser only deletes the local copy; the key stays valid until its TTL runs out.</p>
      <div class="err"></div>
    </div>`);
  s.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).dataset.a;
    if (a === 'revoke' && key) {
      K().then((k) => k.revokeKey(key!)).then(() => { key = null; localStorage.removeItem('readFid'); location.hash = '#/'; renderMe(); route(); })
        .catch((x) => { s.querySelector('.err')!.textContent = (x as Error).message; });
      return;
    }
    if (a === 'forget' || a === 'reset') { forgetKey(); key = null; }
    if (a === 'reset') localStorage.removeItem('readFid');
    if (a === 'connect' || a === 'forget' || a === 'reset') { location.hash = a === 'connect' ? '#/setup' : '#/'; renderMe(); route(); }
  });
  $view.append(s);
}

// ---------- router ----------

let routeGen = 0;
async function route() {
  const gen = ++routeGen;
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  stopLive();
  try {
    if (parts[0] === 'live') return await viewLive($view);
    if (parts[0] === 'u' && parts[1]) {
      const fid = /^\d+$/.test(parts[1]) ? Number(parts[1]) : await fidByName(decodeURIComponent(parts[1]));
      if (!fid) { $view.innerHTML = `<div class="center">No account named ${esc(decodeURIComponent(parts[1]))} on your node.</div>`; return; }
      return await viewProfile(fid);
    }
    if (parts[0] === 'read' && parts[1]) { // #/read/<username>: open that account's home feed, read-only (links from the guide)
      const name = decodeURIComponent(parts[1]).replace(/^@/, '');
      const fid = /^\d+$/.test(name) ? Number(name) : await fidByName(name);
      if (!fid) { $view.innerHTML = `<div class="center">No account named ${esc(name)} on this node.</div>`; return; }
      if (!key) localStorage.setItem('readFid', String(fid));
      history.replaceState(null, '', '#/'); renderMe();
      return await viewFeed();
    }
    if (parts[0] === 'search') return viewSearch(decodeURIComponent(parts[1] || ''));
    if (parts[0] === 'c' && parts[2]) return await viewThread(Number(parts[1]), parts[2]);
    if (parts[0] === 'ch' && parts[1]) return await viewChannel(decodeURIComponent(parts[1]));
    if (parts[0] === 'settings') return viewSettings();
    if (parts[0] === 'n') return await viewReplies();
    if (parts[0] === 'setup') return viewSetup();
    return await viewFeed();
  } catch (e) {
    if (gen !== routeGen) return; // you already moved on; don't paint an old page's error over the new one
    $view.innerHTML = `<div class="card err">${esc((e as Error).message)}</div>`;
  }
}

document.getElementById('theme')!.addEventListener('click', () => {
  const r = document.documentElement;
  r.dataset.theme = r.dataset.theme === 'light' ? 'dark' : 'light';
  try { localStorage.setItem('theme', r.dataset.theme); } catch { /* private mode */ }
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', r.dataset.theme === 'light' ? '#f2f2ee' : '#0d0d0f');
});

// A shared /c/<fid>/<hash> link opens the same thread view.
const shared = location.pathname.match(/^\/c\/(\d+)\/(0x[0-9a-fA-F]+)\/?$/);
if (shared) history.replaceState(null, '', `/#/c/${shared[1]}/${shared[2]}`);

window.addEventListener('hashchange', () => { markTab(); route(); });
nodeStatus();
setInterval(nodeStatus, 15000);
loadConfig().then((c) => { cfg = c; renderMe(); route(); });
// Signed in? Fetch the posting code in the background, so the first like or cast is instant.
if (key) setTimeout(() => { M().catch(() => {}); }, 3000);
