'use client';
import { createContext, useContext, useEffect, useState } from 'react';
import { dict } from '@/lib/i18n';
const Ctx = createContext(null);
export const usePrefs = () => useContext(Ctx);
export function Prefs({ children }) {
  const [lang, setLang] = useState('fa'), [theme, setTheme] = useState('dark');
  useEffect(() => { setLang(localStorage.lang || 'fa'); setTheme(localStorage.theme || 'dark'); }, []);
  useEffect(() => {
    const d = document.documentElement;
    d.lang = lang; d.dir = lang === 'fa' ? 'rtl' : 'ltr'; d.dataset.theme = theme;
    localStorage.lang = lang; localStorage.theme = theme;
  }, [lang, theme]);
  const t = k => dict[lang][k] ?? k;
  return <Ctx.Provider value={{ lang, setLang, theme, setTheme, t }}>{children}</Ctx.Provider>;
}
export function Bar() {
  const { lang, setLang, theme, setTheme } = usePrefs();
  return (
    <div className="bar">
      <span className="brand">NOISY</span>
      <span style={{ display: 'flex', gap: 8 }}>
        <button className="chip" onClick={() => setLang(lang === 'fa' ? 'en' : 'fa')}>{lang === 'fa' ? 'EN' : 'فا'}</button>
        <button className="chip" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? '☀' : '☾'}</button>
      </span>
    </div>
  );
}
