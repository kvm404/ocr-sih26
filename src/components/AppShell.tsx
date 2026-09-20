"use client";

import { usePathname } from "next/navigation";
import Header from "@/components/Header";
import Footer from "@/components/Footer";

export default function AppShell({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const inspectPage = pathname === "/scan";
  const isLanding = pathname === "/";

  return (
    <>
      <Header />
      <main
        id="content"
        className={isLanding ? undefined : "min-h-screen bg-white"}
      >
        {children}
      </main>
      {inspectPage ? (
        <div className="hidden lg:block">
          <Footer />
        </div>
      ) : (
        <Footer />
      )}
    </>
  );
}
