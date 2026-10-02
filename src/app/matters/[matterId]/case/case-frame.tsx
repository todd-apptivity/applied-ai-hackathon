"use client";

/**
 * Frames the case view and keeps it responsive: the desk design on a wide
 * window, the phone design on a narrow one, switching as the window resizes.
 *
 * The frame is in the server-rendered HTML, so the case opens even before (or
 * without) this component's script running. The server's guess at the device
 * comes from the User-Agent; the window's actual width corrects it.
 */

import { useEffect, useState } from "react";

const PHONE = "(max-width: 760px)";

export function CaseFrame({
  matterId,
  title,
  initialPhone,
}: {
  matterId: number;
  title: string;
  initialPhone: boolean;
}) {
  const [phone, setPhone] = useState(initialPhone);

  useEffect(() => {
    const query = window.matchMedia(PHONE);
    const sync = () => setPhone(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  return (
    <iframe
      key={phone ? "phone" : "desktop"}
      title={title}
      src={`/matters/${matterId}/case/view?device=${phone ? "phone" : "desktop"}`}
      className="min-h-0 w-full flex-1 border-0 bg-background"
    />
  );
}
