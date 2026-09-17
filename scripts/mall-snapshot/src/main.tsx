import React from "react";
import { createRoot } from "react-dom/client";
import { Providers } from "./app/providers";
import Header from "./components/Header";
import CartDrawer from "./components/CartDrawer";
import { App } from "./App";
import { patchFetch } from "./patch-fetch";
import "./app/globals.css";

patchFetch();
if (!window.location.hash) {
  window.location.hash = "/";
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <React.StrictMode>
    <Providers>
      <Header />
      <CartDrawer />
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <App />
      </main>
      <footer className="border-t border-slate-200 bg-white py-6 text-center text-sm text-slate-500">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p>© {new Date().getFullYear()} International Mall (国际商城). All rights reserved.</p>
          <p className="text-xs text-slate-400">
            Multi-Currency Engine: USD • EUR • CNY • JPY | English & 简体中文
          </p>
        </div>
      </footer>
    </Providers>
  </React.StrictMode>,
);
