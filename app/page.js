import { redirect } from 'next/navigation';
import { currentUser, pub } from '@/lib/auth';
import Dash from '@/components/Dash';
export const dynamic = 'force-dynamic';
export default function Home() {
  const u = currentUser();
  if (!u) redirect('/login');
  const e = process.env;
  return <Dash me={pub(u)} ingest={`rtmp://${e.NOISY_INGEST_HOST}:${e.NOISY_INGEST_PORT}/${e.NOISY_INGEST_APP}`} />;
}
