// Builds site/endernet.mobileconfig — the downloadable iOS install file.
//
// A WebClip configuration profile is the one kind of "app file" an iPhone
// will take straight from a web page with no store, no developer account and
// no sideloading tool: Safari downloads it, Settings installs it, and the
// result is the Ender Net icon on the home screen opening app.html
// full-screen. It works in the European Union and everywhere else, because
// it is not app distribution at all — it is a bookmark with an icon and a
// FullScreen flag, delivered as a file.
//
// The profile is unsigned on purpose. Signing a profile is S/MIME with any
// certificate chaining into iOS's trust store — a private key this repo has
// nowhere safe to hold, for a signature that would only name a publisher and
// change nothing about what the file does. iOS shows "Not Signed" in the
// installer and installs it anyway. The honest answer to that warning is the
// install page's "what is in the file" section, which shows this exact XML.
//
// Everything in here is deterministic — UUIDs are derived from fixed strings,
// the icon is the committed 180px PNG — so rebuilding from the same inputs
// yields byte-identical output and a diff of the artifact means a real change.
// Usage: node tools/make-webclip.mjs
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const site = resolve(here, '../../site');

// The canonical address, not the tunnel: the tunnel domain dies on every
// restart, while the Pages address resolves the current host by itself.
const APP_URL = 'https://enderpeer.github.io/peer-network-lab/app.html';

// One version-4-shaped UUID per fixed name. Not random: a profile that is
// rebuilt without changes must not LOOK changed, and iOS treats the UUID as
// the profile's identity — a stable UUID means reinstalling replaces the old
// web clip instead of stacking a second icon.
function uuidFrom(seed) {
  const h = createHash('sha256').update(seed).digest('hex').toUpperCase();
  return [
    h.slice(0, 8), h.slice(8, 12),
    // Stamp the version/variant nibbles so the string is a well-formed v4
    // UUID rather than 32 arbitrary hex digits wearing dashes.
    '4' + h.slice(13, 16), '8' + h.slice(17, 20), h.slice(20, 32),
  ].join('-');
}

const icon = readFileSync(resolve(site, 'icons/icon-180.png'));
// <data> accepts whitespace inside base64; wrapped lines keep the file
// readable in the "what is in the file" viewer.
const iconB64 = icon.toString('base64').replace(/(.{60})/g, '$1\n');

const profile = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>PayloadContent</key>
	<array>
		<dict>
			<key>FullScreen</key>
			<true/>
			<key>Icon</key>
			<data>
${iconB64}
			</data>
			<key>IsRemovable</key>
			<true/>
			<key>Label</key>
			<string>Ender Net</string>
			<key>PayloadDescription</key>
			<string>Puts the Ender Net icon on your home screen. It opens the app full-screen.</string>
			<key>PayloadDisplayName</key>
			<string>Ender Net home screen icon</string>
			<key>PayloadIdentifier</key>
			<string>io.github.enderpeer.webclip.app</string>
			<key>PayloadType</key>
			<string>com.apple.webClip.managed</string>
			<key>PayloadUUID</key>
			<string>${uuidFrom('endernet-webclip-payload')}</string>
			<key>PayloadVersion</key>
			<integer>1</integer>
			<key>Precomposed</key>
			<true/>
			<key>URL</key>
			<string>${APP_URL}</string>
		</dict>
	</array>
	<key>PayloadDescription</key>
	<string>Installs the Ender Net app icon on your home screen. This file contains exactly one instruction: place this icon, pointing at ${APP_URL}, and open it full-screen. It changes no settings, adds no certificates, and can be removed at any time under Settings.</string>
	<key>PayloadDisplayName</key>
	<string>Ender Net</string>
	<key>PayloadIdentifier</key>
	<string>io.github.enderpeer.webclip</string>
	<key>PayloadRemovalDisallowed</key>
	<false/>
	<key>PayloadType</key>
	<string>Configuration</string>
	<key>PayloadUUID</key>
	<string>${uuidFrom('endernet-webclip-profile')}</string>
	<key>PayloadVersion</key>
	<integer>1</integer>
</dict>
</plist>
`;

const out = resolve(site, 'endernet.mobileconfig');
writeFileSync(out, profile, 'utf8');
console.log('wrote', out, `(${profile.length} bytes, icon ${icon.length} bytes)`);
