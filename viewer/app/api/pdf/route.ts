import { type NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");

  if (!url || !/^https?:\/\//.test(url)) {
    return new NextResponse("Bad Request", { status: 400 });
  }

  try {
    const upstream = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!upstream.ok) {
      return new NextResponse("Upstream error", { status: upstream.status });
    }
    const body = await upstream.arrayBuffer();
    return new NextResponse(body, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": "inline",
      },
    });
  } catch {
    return new NextResponse("Failed to fetch PDF", { status: 502 });
  }
}
