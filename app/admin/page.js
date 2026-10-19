import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import Admin from '@/components/Admin';
export const dynamic = 'force-dynamic';
export default function Page() {
  if (currentUser()?.role !== 'admin') redirect('/');
  return <Admin />;
}
