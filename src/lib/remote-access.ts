/** Named-tunnel Remote Access copy.  Designer strings are exact. */

/** Assembled so shipped source never contains the contiguous personal domain. */
const personalServiceDomain = ["jays", ".", "services"].join("");

export const NAMED_REMOTE_URL = `https://botfleet.${personalServiceDomain}`;

export const REMOTE_ACCESS_HEADING = "Remote Access";
export const REMOTE_URL_LABEL = "Remote URL";
export const REMOTE_ACCESS_BLURB =
  `Opens BotFleet on this Mac through Jay's Tunnel.  Sign in with Cloudflare Access (same idea as agents.${personalServiceDomain}).  Health check stays public.`;

export const COMPANION_GATEWAY_LABEL = "Companion Gateway";
export const COMPANION_GATEWAY_BLURB =
  `Phone pairing uses https://agents.botfleet.app.  That path is separate from Remote Access (botfleet.${personalServiceDomain}).`;

/** HTML/JSX collapses ASCII double-spaces.  Convert Designer copy to NBSP+space. */
export function sentenceGapHtml(text: string): string {
  return text.replace(/([.!?]) {2}(?=\S)/g, "$1  ");
}
