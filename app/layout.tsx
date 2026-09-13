import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Eel Slap",
  description:
    "A man, an eel, and the inevitable. Procedural 3D scene rendered with three.js WebGPURenderer, react-three-fiber and TSL.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
