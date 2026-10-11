import { ReactNode, createContext, useCallback, useContext, useEffect, useState } from 'react';

export interface Branding {
  siteName: string;
  hasLogoDark: boolean;
  hasLogoLight: boolean;
  version: number;
}

interface Ctx extends Branding {
  refresh: () => Promise<void>;
  set: (b: Branding) => void;
}

const DEFAULT: Branding = { siteName: 'Docs', hasLogoDark: false, hasLogoLight: false, version: 0 };
const BrandingCtx = createContext<Ctx>({ ...DEFAULT, refresh: async () => {}, set: () => {} });
export const useBranding = (): Ctx => useContext(BrandingCtx);

function setFavicons(version: number): void {
  document.querySelectorAll('link[data-brand-icon]').forEach((n) => n.remove());
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
    setFavicons(b.version);
  }, [b.siteName, b.version]);

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
