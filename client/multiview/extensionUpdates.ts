import { COMPANION_RELEASE_VERSION } from '../../shared/extensionBrand';
import { type ExtensionBrowser, type ExtensionPackage, type ExtensionPackages } from './extensionDistribution';

export interface ExtensionUpdateTarget { version: string; requiredCapabilities: readonly string[]; }
export interface MissingExtensionFeature { capability: string; label: string; minimumVersion?: string; }
export const expectedExtensionFeatures: readonly MissingExtensionFeature[] = [
  { capability: 'unified-authorization', label: '本机B站账号' },
  { capability: 'audio-playback', label: '省流量收听' },
  { capability: 'following', label: 'B站关注', minimumVersion: '0.1.0' },
  { capability: 'public-room', label: '自定义直播间' },
  { capability: 'public-playback', label: '匿名直播观看' },
  { capability: 'anonymous-danmaku', label: '匿名弹幕' }
];
const followingStatusFeature: MissingExtensionFeature = { capability: 'following-status', label: '关注列表快速更新', minimumVersion: '0.1.0' };
export const MIN_MEDAL_SELECTION_VERSION = '0.1.0';
const medalFeature: MissingExtensionFeature = { capability: 'medals', label: '完整粉丝勋章列表', minimumVersion: MIN_MEDAL_SELECTION_VERSION };
export const MIN_ROOM_MEDAL_VERSION = '0.1.0';
const roomMedalFeature: MissingExtensionFeature = { capability: 'medal-room-context', label: '直播间勋章优先展示', minimumVersion: MIN_ROOM_MEDAL_VERSION };
const optionalFeatures = [followingStatusFeature, medalFeature, roomMedalFeature];

function versionParts(value: string): number[] | null {
  if (!/^(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){0,3}$/.test(value)) return null;
  const parts = value.split('.').map(Number);
  return parts.every(part => part <= 65535) ? [...parts, ...Array(4 - parts.length).fill(0)] : null;
}

/** Numeric components, not lexicographic order or decimal numbers. */
export function compareExtensionVersions(left: string, right: string): number | null {
  const a = versionParts(left), b = versionParts(right);
  if (!a || !b) return null;
  for (let index = 0; index < 4; index++) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  return 0;
}

export function supportsMedalSelection(version: string, capabilities: readonly string[] | undefined): boolean {
  return Boolean(capabilities?.includes('medals')) && (compareExtensionVersions(version, MIN_MEDAL_SELECTION_VERSION) ?? -1) >= 0;
}

export function supportsMedalRoomContext(version: string, capabilities: readonly string[] | undefined): boolean {
  return supportsMedalSelection(version, capabilities) && Boolean(capabilities?.includes('medal-room-context')) &&
    (compareExtensionVersions(version, MIN_ROOM_MEDAL_VERSION) ?? -1) >= 0;
}

/** A version label is not evidence of working capabilities: completion always
 * uses the extension's actual HELLO result as well. */
export function isExtensionUpdateSatisfied(target: ExtensionUpdateTarget | null | undefined, installedVersion: string,
  capabilities: readonly string[] | undefined): boolean {
  if (!target) return false;
  const comparison = compareExtensionVersions(installedVersion, target.version);
  return comparison !== null && comparison >= 0 && target.requiredCapabilities.every(capability => capabilities?.includes(capability));
}

export interface ExtensionUpdateSummary {
  latestVersion: string;
  updateAvailable: boolean;
  missingFeatures: MissingExtensionFeature[];
  download: ExtensionPackage | null;
  target: ExtensionUpdateTarget | null;
  downloadTarget: ExtensionUpdateTarget | null;
}

function targetFor(version: string | null | undefined, installedVersion: string): ExtensionUpdateTarget | null {
  if (!version || compareExtensionVersions(version, version) === null || expectedExtensionFeatures.some(feature =>
    feature.minimumVersion && (compareExtensionVersions(version, feature.minimumVersion) ?? -1) < 0)) return null;
  if ((compareExtensionVersions(version, installedVersion) ?? 0) < 0) return null;
  return { version, requiredCapabilities: [...expectedExtensionFeatures.map(feature => feature.capability),
    ...optionalFeatures.filter(feature => compareExtensionVersions(version, feature.minimumVersion!)! >= 0).map(feature => feature.capability)] };
}

/** Only verified file descriptors provide a downloadable update target. */
export function describeExtensionUpdate(options: { browser: ExtensionBrowser; installedVersion: string; capabilities?: readonly string[];
  installationType?: string; packages: ExtensionPackages | null;
}): ExtensionUpdateSummary {
  const download = options.browser === 'other' ? null
    : options.packages?.chrome ?? null;
  const latestVersion = download && (compareExtensionVersions(download.version, COMPANION_RELEASE_VERSION) ?? -1) > 0
    ? download.version : COMPANION_RELEASE_VERSION;
  // A newer installed release is never asked to downgrade to the website's target.
  const targetVersion = (compareExtensionVersions(options.installedVersion, latestVersion) ?? -1) > 0
    ? options.installedVersion : latestVersion;
  const downloadTarget = targetFor(download?.version, options.installedVersion);
  const availableFeatures = optionalFeatures.filter(feature => (compareExtensionVersions(targetVersion, feature.minimumVersion!) ?? -1) >= 0);
  const missingFeatures = options.installedVersion ? [...expectedExtensionFeatures, ...availableFeatures]
    .filter(feature => !options.capabilities?.includes(feature.capability) || Boolean(feature.minimumVersion &&
      (compareExtensionVersions(options.installedVersion, feature.minimumVersion) ?? -1) < 0)).map(feature => ({ ...feature })) : [];
  const comparison = compareExtensionVersions(latestVersion, options.installedVersion);
  return { latestVersion, updateAvailable: Boolean(options.installedVersion) && (missingFeatures.length > 0 || comparison !== null && comparison > 0),
    missingFeatures, download, downloadTarget, target: downloadTarget };
}
