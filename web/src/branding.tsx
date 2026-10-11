import { ReactNode, createContext, useCallback, useContext, useEffect, useState } from 'react';

export interface Branding {
  siteName: string;
  hasLogoDark: boolean;
  hasLogoLight: boolean;
  hasAppIcon?: boolean;
  hasBackground?: boolean;
  version: number;
}

interface Ctx extends Branding {
  refresh: () => Promise<void>;
  set: (b: Branding) => void;
}

const DEFAULT: Branding = { siteName: 'Docs', hasLogoDark: false, hasLogoLight: false, version: 0 };
const BrandingCtx = createContext<Ctx>({ ...DEFAULT, refresh: async () => {}, set: () => {} });
export const useBranding = (): Ctx => useContext(BrandingCtx);

function setFavicons(version: number, hasAppIcon: boolean): void {
  document.querySelectorAll('link[data-brand-icon], link[rel="apple-touch-icon"]').forEach((n) => n.remove());
  if (hasAppIcon) {
    // The square app icon doubles as the browser-tab icon.
    const l = document.createElement('link');
    l.rel = 'icon';
    l.type = 'image/png';
    l.href = `/brand/icon/192?v=${version}`;
    l.setAttribute('data-brand-icon', '');
    document.head.appendChild(l);
  } else {
    for (const [variant, media] of [
      ['light', '(prefers-color-scheme: light)'],
      ['dark', '(prefers-color-scheme: dark)'],
    ] as const) {
      const l = document.createElement('link');
      l.rel = 'icon';
      l.media = media;
      l.href = `/brand/logo/${variant}?v=${version}`;
      l.setAttribute('data-brand-icon', '');
      document.head.appendChild(l);
    }
  }
  const a = document.createElement('link');
  a.rel = 'apple-touch-icon';
  a.href = `/brand/icon/180?v=${version}`;
  a.setAttribute('data-brand-icon', '');
  document.head.appendChild(a);
}

export function BrandingProvider({ children }: { children: ReactNode }) {
  const [b, setB] = useState<Branding>(DEFAULT);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/branding', { credentials: 'same-origin' });
      if (res.ok) setB((await res.json()) as Branding);
    } catch {
      /* keep defaults */
    }
    setReady(true);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    document.title = b.siteName;
    setFavicons(b.version, !!b.hasAppIcon);
    const root = document.documentElement;
    if (b.hasBackground) {
      root.style.setProperty('--brand-bg', `url(/brand/background?v=${b.version})`);
      root.setAttribute('data-bg', '');
    } else {
      root.style.removeProperty('--brand-bg');
      root.removeAttribute('data-bg');
    }
  }, [b.siteName, b.version, b.hasAppIcon, b.hasBackground]);

  if (!ready) return null;
  return <BrandingCtx.Provider value={{ ...b, refresh, set: setB }}>{children}</BrandingCtx.Provider>;
}

/** The logo for the current theme (CSS shows the right one); falls back to a neutral default icon. */
export function Logo() {
  const { version } = useBranding();
  return (
    <>
      <img className="logo-dark" src={`/brand/logo/dark?v=${version}`} alt="" />
      <img className="logo-light" src={`/brand/logo/light?v=${version}`} alt="" />
    </>
  );
}
