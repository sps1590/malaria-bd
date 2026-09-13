import { nspComparison } from "@/lib/nsp";

/** Population at risk and NSP targets vs actual and forecast: ?district=<name> or the 13 at-risk districts. */
export async function GET(request: Request) {
  const district = new URL(request.url).searchParams.get("district") || undefined;
  try {
    return Response.json(await nspComparison({ district }));
  } catch (err) {
    return Response.json({ available: false, note: err instanceof Error ? err.message : "Failed to load NSP targets" }, { status: 500 });
  }
}
