import React from "react";

type Props = React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
};

export function toHashHref(href: string): string {
  if (
    !href ||
    href.startsWith("#") ||
    href.startsWith("http") ||
    href.startsWith("mailto:") ||
    href.startsWith("data:")
  ) {
    return href;
  }
  if (href.startsWith("/")) {
    const [path, query] = href.split("?");
    return `#${path}${query ? `?${query}` : ""}`;
  }
  return href;
}

export default function Link({ href, children, ...rest }: Props) {
  return (
    <a href={toHashHref(href)} {...rest}>
      {children}
    </a>
  );
}
