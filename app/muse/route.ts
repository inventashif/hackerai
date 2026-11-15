import { NextResponse } from "next/server";

// The Bug Bounty Dashboard lives as a Muse space. muse.ai sends framing
// protections, so the dashboard cannot be embedded in an iframe here
// (browsers refuse to display it). /muse is therefore a redirect: the
// stable shortcut on this domain that takes the user straight to it.
const DASHBOARD_URL =
  "https://muse.ai/s/bug-bounty-dashboard-xnq74uxlxwnoaxt/XoyJMec1Bs7DYiIyw90wcZY3D-MKhepY5N9UHTzt7KU";

export function GET() {
  // 307 (not 308): keep the redirect re-checkable so the target can change
  // later without fighting cached permanent redirects.
  return NextResponse.redirect(DASHBOARD_URL, 307);
}
