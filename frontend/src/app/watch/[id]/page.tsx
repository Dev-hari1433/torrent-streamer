import { notFound } from 'next/navigation';
import WatchClient from '@/components/WatchClient';
export default async function WatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[a-f0-9]{40}$/.test(id)) notFound();
  return <WatchClient id={id} />;
}
