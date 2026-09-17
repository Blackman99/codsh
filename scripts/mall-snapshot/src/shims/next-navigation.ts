import { useEffect, useState } from "react";

export function hashPath(): string {
  if (typeof window === "undefined") return "/";
  const raw = window.location.hash.replace(/^#/, "") || "/";
  const queryAt = raw.indexOf("?");
  const path = queryAt >= 0 ? raw.slice(0, queryAt) : raw;
  if (!path || path === "index.html") return "/";
  return path.startsWith("/") ? path : `/${path}`;
}

export function hashSearch(): string {
  if (typeof window === "undefined") return "";
  const raw = window.location.hash.replace(/^#/, "");
  const queryAt = raw.indexOf("?");
  return queryAt >= 0 ? raw.slice(queryAt + 1) : "";
}

export function useRouter() {
  return {
    push(href: string) {
      const hash = href.startsWith("#") ? href.slice(1) : href;
      window.location.hash = hash.startsWith("/") ? hash : `/${hash}`;
    },
  };
}

export function useSearchParams() {
  const [search, setSearch] = useState(hashSearch);
  useEffect(() => {
    const onChange = () => setSearch(hashSearch());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const params = new URLSearchParams(search);
  return {
    get(key: string) {
      return params.get(key);
    },
  };
}

export function usePathname() {
  const [path, setPath] = useState(hashPath);
  useEffect(() => {
    const onChange = () => setPath(hashPath());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return path;
}

export function notFound(): never {
  throw new Error("NEXT_NOT_FOUND");
}
