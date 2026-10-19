import './globals.css';
import { Prefs, Bar } from '@/components/Prefs';
export const metadata = { title: 'Noisy' };
export default function Layout({ children }) {
  return (
    <html lang="fa" dir="rtl" data-theme="dark" suppressHydrationWarning>
      <body><Prefs><div className="wrap"><Bar />{children}</div></Prefs></body>
    </html>
  );
}
