export type ThemePref = 'dark' | 'light' | 'system';

export function resolveTheme(pref: ThemePref): 'dark' | 'light' {
  if (pref !== 'system') return pref;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function applyTheme(pref: ThemePref): void {
  try {
    localStorage.setItem('docs_theme', pref);
  } catch {
    /* storage unavailable */
  }
  const t = resolveTheme(pref);
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'dark' ? '#0B0D12' : '#F6F7FB');
}

export function savedTheme(): ThemePref {
  try {
    const v = localStorage.getItem('docs_theme');
    if (v === 'dark' || v === 'light' || v === 'system') return v;
  } catch {
    /* ignore */
  }
  return 'system';
}

// Follow OS changes while preference is "system".
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (savedTheme() === 'system') applyTheme('system');
});
