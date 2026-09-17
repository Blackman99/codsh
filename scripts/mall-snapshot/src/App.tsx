import React, { Suspense } from "react";
import { usePathname } from "./shims/next-navigation";
import { getProductById, getProducts, getOrderById } from "./lib/store";
import HomeClient from "./components/HomeClient";
import ProductCatalog from "./components/ProductCatalog";
import ProductDetailClient from "./components/ProductDetailClient";
import CategoriesPage from "./app/categories/page";
import CartClient from "./components/CartClient";
import CheckoutClient from "./components/CheckoutClient";
import OrderConfirmationClient from "./components/OrderConfirmationClient";
import OrderTrackClient from "./components/OrderTrackClient";
import Link from "./shims/next-link";

function Missing({ title }: { title: string }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center shadow-sm">
      <h2 className="text-2xl font-bold text-slate-900 mb-3">{title}</h2>
      <Link href="/products" className="text-indigo-600 font-medium hover:text-indigo-700">
        Browse products
      </Link>
    </div>
  );
}

export function App() {
  const path = usePathname();
  const products = getProducts();

  if (path === "/" || path === "") {
    return <HomeClient initialProducts={products} />;
  }
  if (path === "/products") {
    return (
      <div className="space-y-8">
        <ProductCatalog initialProducts={products} showBanner={true} />
      </div>
    );
  }
  if (path.startsWith("/products/")) {
    const id = decodeURIComponent(path.slice("/products/".length).split("/")[0] || "");
    const product = getProductById(id);
    if (!product) return <Missing title="Product not found" />;
    return <ProductDetailClient product={product} />;
  }
  if (path === "/categories") return <CategoriesPage />;
  if (path === "/cart") return <CartClient />;
  if (path === "/checkout") return <CheckoutClient />;
  if (path.startsWith("/order/confirmation/")) {
    const id = decodeURIComponent(
      path.slice("/order/confirmation/".length).split("/")[0] || "",
    );
    const order = getOrderById(id) || null;
    return <OrderConfirmationClient initialOrder={order} orderId={id} />;
  }
  if (path === "/order/track") {
    return (
      <Suspense
        fallback={
          <div className="max-w-4xl mx-auto px-4 py-16 text-center text-gray-500 text-sm">
            Loading order tracking...
          </div>
        }
      >
        <OrderTrackClient />
      </Suspense>
    );
  }

  return <Missing title="Page not found" />;
}
