import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Treasury Agent — Trust Console',
  description:
    'Read-only trust console for the Sui treasury agent: subagent health, market rates, positions, proposals, plans, receipts, and risk locks.'
};

export default function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
