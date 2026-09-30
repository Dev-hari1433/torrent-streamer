import type { Metadata } from 'next';
import './globals.css';
import './cinema.css';
export const metadata: Metadata = { title: 'Lumora — Your personal streaming room', description: 'A P2P media player with original video quality and live swarm telemetry.' };
export default function RootLayout({ children }: { children: React.ReactNode }) { return <html lang="en"><body>{children}</body></html>; }
