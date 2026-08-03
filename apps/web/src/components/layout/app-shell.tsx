'use client';

import { useState } from 'react';
import { Sidebar } from './sidebar';
import { Navbar } from './navbar';

export function AppShell({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    // 注意：此处不得刷不透明 bg-background——body::before 的全局网格纹理在 z-index:-1，
    // 不透明底色会把它整个盖住；底色由 body 负责（globals.css 有说明）
    <div className="min-h-screen">
      <Sidebar mobileOpen={mobileOpen} onMobileClose={() => setMobileOpen(false)} />
      <div className="ml-0 md:ml-64 min-h-screen">
        <Navbar onMenuClick={() => setMobileOpen(true)} />
        <main className="p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
