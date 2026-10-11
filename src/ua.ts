export interface ParsedUA {
  browser: string;
  browserVer: string | null;
  os: string;
  osVer: string | null;
  device: 'mobile' | 'tablet' | 'desktop';
  inApp: string | null;
}

const IN_APP: [RegExp, string][] = [
  [/Instagram/i, 'Instagram'],
  [/FBAN|FBAV|FB_IAB/i, 'Facebook'],
  [/LinkedInApp/i, 'LinkedIn'],
  [/Snapchat/i, 'Snapchat'],
  [/TikTok|musical_ly|BytedanceWebview/i, 'TikTok'],
  [/Twitter/i, 'X (Twitter)'],
  [/WhatsApp/i, 'WhatsApp'],
  [/Telegram/i, 'Telegram'],
  [/Slack/i, 'Slack'],
  [/Discord/i, 'Discord'],
  [/Teams\/|MicrosoftTeams/i, 'Teams'],
  [/\bLine\//i, 'LINE'],
  [/GSA\//, 'Google app'],
];

const major = (v: string | undefined | null): string | null => (v ? v.split(/[._]/)[0] : null);

export function parseUA(ua: string): ParsedUA {
  const inApp = IN_APP.find(([re]) => re.test(ua))?.[1] ?? null;

  // --- OS ---
  let os = 'Other';
  let osVer: string | null = null;
  let m: RegExpExecArray | null;
  if ((m = /(iPhone|iPad|iPod)[^)]*?OS (\d+[_\d]*)/.exec(ua))) {
    os = 'iOS';
    osVer = major(m[2]);
  } else if (/iPhone|iPad|iPod/.test(ua)) {
    os = 'iOS';
  } else if ((m = /Android (\d+(?:\.\d+)*)/.exec(ua))) {
    os = 'Android';
    osVer = major(m[1]);
  } else if (/Android/.test(ua)) {
    os = 'Android';
  } else if (/CrOS/.test(ua)) {
    os = 'ChromeOS';
  } else if (/Windows NT/.test(ua)) {
    os = 'Windows';
    const nt = /Windows NT (\d+\.\d+)/.exec(ua)?.[1];
    osVer = nt === '10.0' ? '10/11' : nt === '6.3' ? '8.1' : nt === '6.1' ? '7' : (nt ?? null);
  } else if ((m = /Mac OS X (\d+[_.]\d+)/.exec(ua))) {
    os = 'macOS';
    const v = Number(m[1].replace('_', '.'));
    osVer = v >= 11 ? String(Math.floor(v)) : null; // browsers freeze this at 10.15
  } else if (/Linux|X11/.test(ua)) {
    os = 'Linux';
  }

  // --- Browser (order matters: most specific first) ---
  let browser = 'Other';
  let ver: string | null = null;
  const pick = (re: RegExp, name: string): boolean => {
    const r = re.exec(ua);
    if (!r) return false;
    browser = name;
    ver = major(r.slice(1).find(Boolean));
    return true;
  };
  pick(/EdgA?\/(\d+[\d.]*)|Edge\/(\d+[\d.]*)/, 'Edge') ||
    pick(/OPR\/(\d+[\d.]*)|OPiOS\/(\d+[\d.]*)/, 'Opera') ||
    pick(/SamsungBrowser\/(\d+[\d.]*)/, 'Samsung Internet') ||
    pick(/(?:Firefox|FxiOS)\/(\d+[\d.]*)/, 'Firefox') ||
    pick(/DuckDuckGo\/(\d+[\d.]*)/, 'DuckDuckGo') ||
    pick(/(?:Chrome|CriOS)\/(\d+[\d.]*)/, 'Chrome') ||
    pick(/Version\/(\d+[\d.]*).*Safari\//, 'Safari');
  if (browser === 'Other' && /Safari\//.test(ua)) browser = 'Safari';
  if (browser === 'Other' && inApp) browser = `${inApp} in-app`;
  if (browser === 'Other' && /AppleWebKit/.test(ua) && os === 'iOS') browser = 'iOS web view';
  if (!ver && /(?:Edg|OPR)/.test(ua)) ver = null;

  // --- Device ---
  let device: ParsedUA['device'] = 'desktop';
  if (/iPad|Tablet|PlayBook|Silk/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))) device = 'tablet';
  else if (/Mobi|iPhone|iPod|Android/.test(ua)) device = 'mobile';

  return { browser, browserVer: ver, os, osVer, device, inApp };
}

const HOSTS: [RegExp, string][] = [
  [/(^|\.)google\.[a-z.]+$/, 'Google'],
  [/(^|\.)bing\.com$/, 'Bing'],
  [/(^|\.)duckduckgo\.com$/, 'DuckDuckGo'],
  [/(^|\.)linkedin\.com$|(^|\.)lnkd\.in$/, 'LinkedIn'],
  [/(^|\.)facebook\.com$|(^|\.)fb\.com$/, 'Facebook'],
  [/(^|\.)instagram\.com$/, 'Instagram'],
  [/(^|\.)t\.co$|(^|\.)twitter\.com$|(^|\.)x\.com$/, 'X (Twitter)'],
  [/(^|\.)telegram\.org$|(^|\.)t\.me$/, 'Telegram'],
  [/(^|\.)whatsapp\.com$|(^|\.)wa\.me$/, 'WhatsApp'],
  [/(^|\.)slack\.com$/, 'Slack'],
  [/^mail\.google\.com$/, 'Gmail'],
  [/outlook\.(live|office|office365)\.com$/, 'Outlook'],
  [/(^|\.)teams\.microsoft\.com$/, 'Teams'],
  [/(^|\.)notion\.so$/, 'Notion'],
  [/(^|\.)reddit\.com$/, 'Reddit'],
];

/** Human-friendly traffic source from the referrer host and in-app browser hint. */
export function sourceLabel(host: string | null, inApp: string | null): string {
  if (host) {
    const h = host.toLowerCase().replace(/:\d+$/, '');
    return HOSTS.find(([re]) => re.test(h))?.[1] ?? h;
  }
  return inApp ?? 'Direct / unknown';
}
