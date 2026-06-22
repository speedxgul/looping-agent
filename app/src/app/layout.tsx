import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import '@mysten/dapp-kit/dist/index.css';
import './globals.css';
import Providers from '@/components/Providers';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap'
});

export const metadata: Metadata = {
  title: 'HexLiquid Yield — Autonomous Yield on Sui',
  description:
    'An autonomous, non-custodial treasury agent that deploys idle stablecoins into verifiable on-chain yield on Sui. Launch the trust console to watch it work.'
};

export default function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
