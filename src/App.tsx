import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowDownToLine,
  Boxes,
  Check,
  CheckCircle2,
  ChevronRight,
  Download,
  ExternalLink,
  FileArchive,
  Globe2,
  Home,
  Library,
  LoaderCircle,
  Monitor,
  Minimize2,
  Moon,
  Music2,
  PackageOpen,
  Plus,
  Power,
  RefreshCw,
  Rocket,
  Search,
  Settings,
  ShieldCheck,
  Sun,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import type {
  BrandIconShape,
  CloseBehavior,
  DownloadItem,
  DownloadProgressPayload,
  GithubPackageTarget,
  GithubRepositoryInfo,
  InstalledAppInfo,
  NontHubApp,
  NontHubUserProfile,
  PlatformInfo,
  ResolvedAsset,
  SyncedRepository,
  ThemeMode,
} from "./types";

type Page = "home" | "library" | "downloads" | "installer" | "settings";
type UpdateStatus = "idle" | "checking" | "current" | "available" | "unreleased" | "error";
type GithubAddAction = "download" | "install";

type ReleaseCheck = {
  status: UpdateStatus;
  version?: string;
  asset?: ResolvedAsset;
  message?: string;
};

const NONTHUB_FALLBACK_VERSION = "3.0.1";
const NONTHUB_REPOSITORY = "voidnont/NontHub";
const NONT_REPOSITORY = "voidnont/NontMusic";
const VEIL_REPOSITORY = "voidnont/veilbrowser";
const NONTHUB_WEBSITE = "https://www.nont.me";
const NONT_MUSIC_WEBSITE = "https://music.nont.me";

const nav: Array<{ page: Page; label: string; icon: typeof Home }> = [
  { page: "home", label: "Home", icon: Home },
  { page: "library", label: "Library", icon: Library },
  { page: "downloads", label: "Downloads", icon: Download },
  { page: "installer", label: "Installer", icon: PackageOpen },
  { page: "settings", label: "Settings", icon: Settings },
];


async function openOfficialWebsite(url: string) {
  try {
    await invoke("open_official_website", { url });
  } catch (error) {
    console.error(`Could not open ${url}`, error);
  }
}

const targetLabels: Record<GithubPackageTarget, string> = {
  auto: "Auto · Windows compatible",
  exe: "Windows · EXE",
  msi: "Windows · MSI",
};

function formatBytes(bytes?: number) {
  if (!Number.isFinite(bytes) || (bytes ?? 0) <= 0) return "0 B";
  const value = bytes as number;
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function displayPath(path?: string | null) {
  if (!path) return "";
  // Never expose the Windows account name in the NontHub UI.
  return path.replace(/^([A-Za-z]:\\Users\\)[^\\]+/i, "$1%USERNAME%");
}

function installedAssetChanged(asset: ResolvedAsset, installed?: InstalledAppInfo | null) {
  if (!installed?.installed) return false;
  // Legacy installs may not store release-asset identity, so offer one refresh update
  // to migrate them to digest and asset-ID based tracking.
  if (!installed.asset_id && !installed.asset_digest && !installed.release_tag) return true;
  if (installed.asset_id && asset.asset_id && installed.asset_id !== asset.asset_id) return true;
  if (installed.asset_digest && asset.asset_digest && installed.asset_digest !== asset.asset_digest) return true;
  if (installed.asset_updated_at && asset.asset_updated_at && installed.asset_updated_at !== asset.asset_updated_at) return true;
  if (installed.release_tag && asset.tag_name && installed.release_tag !== asset.tag_name) return true;
  return false;
}

function cleanVersion(value?: string | null) {
  return (value ?? "").trim().replace(/^v/i, "");
}

function versionParts(value?: string | null): number[] | null {
  const cleaned = cleanVersion(value);
  const match = cleaned.match(/\d+(?:\.\d+)*/);
  if (!match) return null;
  const parts = match[0].split(".").map((part) => Number.parseInt(part, 10));
  return parts.every(Number.isFinite) ? parts : null;
}

// Returns 1 when latest is newer, 0 when equal, -1 when current is newer,
// and null when either label cannot be compared safely.
function compareVersions(latest?: string | null, current?: string | null): 1 | 0 | -1 | null {
  const a = versionParts(latest);
  const b = versionParts(current);
  if (!a || !b) return null;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left > right) return 1;
    if (left < right) return -1;
  }
  return 0;
}


function sanitizeDownloads(value: unknown): DownloadItem[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 120).map((item) =>
    item && typeof item === "object" && (item as DownloadItem).status !== undefined
      ? ((item as DownloadItem).status === "downloading" || (item as DownloadItem).status === "queued"
        ? { ...(item as DownloadItem), status: "failed" as const, error: "Download was interrupted when NontHub closed." }
        : item as DownloadItem)
      : null,
  ).filter((item): item is DownloadItem => item !== null);
}

function loadDownloads(): DownloadItem[] {
  try {
    return sanitizeDownloads(JSON.parse(localStorage.getItem("nonthub.downloads") ?? "[]"));
  } catch {
    return [];
  }
}

function downloadErrorState(error: unknown): Pick<DownloadItem, "status" | "error"> {
  const message = String(error);
  if (/download cancelled/i.test(message)) return { status: "cancelled", error: undefined };
  return { status: "failed", error: message };
}

function storedThemeMode(): ThemeMode {
  const value = localStorage.getItem("nonthub.theme");
  return value === "dark" || value === "bright" || value === "system" ? value : "system";
}

function storedBrandIconShape(): BrandIconShape {
  const value = localStorage.getItem("nonthub.brandIconShape");
  return value === "circle" || value === "rounded" ? value : "rounded";
}

function storedCloseBehavior(): CloseBehavior {
  const value = localStorage.getItem("nonthub.closeBehavior");
  return value === "minimize" || value === "exit" || value === "ask" ? value : "ask";
}

function filenameFromUrl(url: string): string {
  const raw = url.split("/").pop()?.split("?")[0] || "download.bin";
  try { return decodeURIComponent(raw); } catch { return raw; }
}

function parseGithubRepository(value: string): string | null {
  const input = value.trim();
  const short = input.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (short) return `${short[1]}/${short[2]}`;
  try {
    const url = new URL(input);
    if (!["github.com", "www.github.com"].includes(url.hostname.toLowerCase())) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2 || (parts[2] === "releases" && parts[3] === "download")) return null;
    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/i, "");
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return null;
    return `${owner}/${repo}`;
  } catch {
    return null;
  }
}

function syncedAppId(repository: string) {
  return `github-${repository.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;
}

function repositoryCategory(info: GithubRepositoryInfo): string {
  const text = `${info.name} ${info.description ?? ""} ${info.topics.join(" ")}`.toLowerCase();
  if (/music|audio|player|sound/.test(text)) return "Music";
  if (/browser|web|internet/.test(text)) return "Web";
  if (/game|gaming/.test(text)) return "Games";
  if (/developer|cli|sdk|tool|utility/.test(text)) return "Tools";
  return "GitHub";
}

function repositoryToSynced(info: GithubRepositoryInfo): SyncedRepository {
  return {
    repository: info.full_name || info.repository,
    app_id: syncedAppId(info.full_name || info.repository),
    name: info.name,
    subtitle: `${info.owner} · GitHub`,
    description: info.description?.trim() || `Synced directly with ${info.full_name || info.repository}.`,
    category: repositoryCategory(info),
    html_url: info.html_url,
    latest_version: info.latest_version,
    latest_release_tag: info.latest_release_tag,
    synced_at: new Date().toISOString(),
  };
}

function sanitizeSyncedRepositories(value: unknown): SyncedRepository[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: SyncedRepository[] = [];
  for (const raw of value.slice(0, 100)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Partial<SyncedRepository>;
    const repository = typeof item.repository === "string" ? item.repository.trim() : "";
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || seen.has(repository.toLowerCase())) continue;
    seen.add(repository.toLowerCase());
    result.push({
      repository,
      app_id: typeof item.app_id === "string" && item.app_id ? item.app_id : syncedAppId(repository),
      name: typeof item.name === "string" && item.name ? item.name : repository.split("/")[1],
      subtitle: typeof item.subtitle === "string" && item.subtitle ? item.subtitle : `${repository.split("/")[0]} · GitHub`,
      description: typeof item.description === "string" && item.description ? item.description : `Synced directly with ${repository}.`,
      category: typeof item.category === "string" && item.category ? item.category : "GitHub",
      html_url: typeof item.html_url === "string" ? item.html_url : `https://github.com/${repository}`,
      latest_version: typeof item.latest_version === "string" ? item.latest_version : null,
      latest_release_tag: typeof item.latest_release_tag === "string" ? item.latest_release_tag : null,
      synced_at: typeof item.synced_at === "string" ? item.synced_at : undefined,
    });
  }
  return result;
}

const WINDOWS_PLATFORM: PlatformInfo = {
  os: "windows",
  arch: "unknown",
  download_location: "Downloads",
};

function packageExtensions(target: GithubPackageTarget): string[] {
  if (target === "exe") return [".exe"];
  if (target === "msi") return [".msi"];
  return [".exe", ".msi"];
}

function installTargetOptions(): GithubPackageTarget[] {
  return ["auto", "exe", "msi"];
}

function installedAppExtensions(info: InstalledAppInfo, fallback: string[] = [".exe", ".msi"]): string[] {
  const packageType = info.package_type?.toLowerCase();
  if (packageType === "exe") return [".exe"];
  if (packageType === "msi") return [".msi"];
  const path = info.executable_path?.toLowerCase() ?? "";
  if (path.endsWith(".msi")) return [".msi"];
  if (path.endsWith(".exe")) return [".exe"];
  return fallback.length ? fallback : packageExtensions("auto");
}

function App() {
  const [page, setPage] = useState<Page>("home");
  const [installerMode, setInstallerMode] = useState<"install" | "update">("install");
  const [catalogApps, setCatalogApps] = useState<NontHubApp[]>([]);
  const [catalogReady, setCatalogReady] = useState(false);
  const [syncedRepositories, setSyncedRepositories] = useState<SyncedRepository[]>([]);
  const apps = useMemo<NontHubApp[]>(() => {
    const catalogRepositories = new Set(catalogApps.map((app) => app.repository?.toLowerCase()).filter(Boolean));
    const syncedApps = syncedRepositories
      .filter((item) => !catalogRepositories.has(item.repository.toLowerCase()))
      .map((item): NontHubApp => ({
        id: item.app_id,
        name: item.name,
        subtitle: item.subtitle,
        description: item.description,
        category: item.category,
        kind: "github-release",
        repository: item.repository,
        featured: false,
        version: item.latest_version ?? undefined,
        synced: true,
      }));
    return [...catalogApps, ...syncedApps];
  }, [catalogApps, syncedRepositories]);
  const [downloads, setDownloads] = useState<DownloadItem[]>(loadDownloads);
  const [query, setQuery] = useState("");
  const [showDownloadDialog, setShowDownloadDialog] = useState(false);
  const [directUrl, setDirectUrl] = useState("");
  const [githubTarget, setGithubTarget] = useState<GithubPackageTarget>("auto");
  const [githubAction, setGithubAction] = useState<GithubAddAction>("download");
  const [githubAssets, setGithubAssets] = useState<ResolvedAsset[]>([]);
  const [githubAssetsBusy, setGithubAssetsBusy] = useState(false);
  const [githubAssetsError, setGithubAssetsError] = useState("");
  const [githubRepoInfo, setGithubRepoInfo] = useState<GithubRepositoryInfo | null>(null);
  const [githubRepoInfoBusy, setGithubRepoInfoBusy] = useState(false);
  const [selectedGithubAssetId, setSelectedGithubAssetId] = useState<number | null>(null);
  const [addBusy, setAddBusy] = useState(false);
  const [repoSyncBusy, setRepoSyncBusy] = useState(false);
  const [repoIcons, setRepoIcons] = useState<Record<string, string>>({});
  const [theme, setTheme] = useState<ThemeMode>(storedThemeMode);
  const [brandIconShape, setBrandIconShape] = useState<BrandIconShape>(storedBrandIconShape);
  const [installedNont, setInstalledNont] = useState<InstalledAppInfo>({ app_id: "nont", installed: false });
  const [installedApps, setInstalledApps] = useState<Record<string, InstalledAppInfo>>({});
  const [appReleaseChecks, setAppReleaseChecks] = useState<Record<string, ReleaseCheck>>({});
  const [appInstallBusy, setAppInstallBusy] = useState<Record<string, boolean>>({});
  const [nontRelease, setNontRelease] = useState<ReleaseCheck>({ status: "idle" });
  const [nonthubRelease, setNontHubRelease] = useState<ReleaseCheck>({ status: "idle" });
  const [installBusy, setInstallBusy] = useState(false);
  const [nonthubVersion, setNontHubVersion] = useState(NONTHUB_FALLBACK_VERSION);
  const [platformInfo, setPlatformInfo] = useState<PlatformInfo>(WINDOWS_PLATFORM);

  const [profileLoaded, setProfileLoaded] = useState(false);
  const [profileStatus, setProfileStatus] = useState<"loading" | "saved" | "error">("loading");
  const profileSaveTimerRef = useRef<number | null>(null);
  const profileSnapshotRef = useRef<NontHubUserProfile | null>(null);
  const initialRepoSyncDoneRef = useRef(false);
  const [initialRepoSyncComplete, setInitialRepoSyncComplete] = useState(false);
  const [closeBehavior, setCloseBehavior] = useState<CloseBehavior>(storedCloseBehavior);
  const [showCloseChoice, setShowCloseChoice] = useState(false);
  const [rememberCloseChoice, setRememberCloseChoice] = useState(true);

  function currentProfile(): NontHubUserProfile {
    return {
      schema_version: 3,
      onboarding_complete: true,
      theme,
      brand_icon_shape: brandIconShape,
      downloads: downloads.slice(0, 120),
      close_behavior: closeBehavior,
      synced_repositories: syncedRepositories.slice(0, 100),
    };
  }


  profileSnapshotRef.current = currentProfile();

  async function persistProfileNow() {
    if (!profileLoaded) return;
    if (profileSaveTimerRef.current !== null) {
      window.clearTimeout(profileSaveTimerRef.current);
      profileSaveTimerRef.current = null;
    }
    await invoke("save_user_profile", { profile: currentProfile() });
    setProfileStatus("saved");
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const profile = await invoke<NontHubUserProfile | null>("load_user_profile");
        if (cancelled) return;
        if (profile) {
          if (["system", "dark", "bright"].includes(profile.theme)) setTheme(profile.theme);
          if (profile.brand_icon_shape && ["rounded", "circle"].includes(profile.brand_icon_shape)) setBrandIconShape(profile.brand_icon_shape);
          if (["ask", "minimize", "exit"].includes(profile.close_behavior)) setCloseBehavior(profile.close_behavior);
          const restoredDownloads = sanitizeDownloads(profile.downloads);
          setDownloads(restoredDownloads);
          setSyncedRepositories(sanitizeSyncedRepositories(profile.synced_repositories));
          localStorage.setItem("nonthub.downloads", JSON.stringify(restoredDownloads));
        }
        setProfileStatus("saved");
      } catch (error) {
        console.error("Could not restore NontHub profile", error);
        // Keep the legacy localStorage values as a migration fallback for the
        // first upgrade from older NontHub versions. A successful save below
        // migrates those values into the stable profile file.
        setProfileStatus("error");
      } finally {
        if (!cancelled) setProfileLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.platform = "windows";
    document.documentElement.dataset.formFactor = "windows";
    void invoke<PlatformInfo>("get_platform_info")
      .then((info) => setPlatformInfo(info))
      .catch((error) => console.warn("Could not read Windows architecture information", error));

    fetch("/catalog.json")
      .then((res) => res.json())
      .then((data) => setCatalogApps(Array.isArray(data.apps) ? data.apps : []))
      .catch(() => setCatalogApps([]))
      .finally(() => setCatalogReady(true));

    void (async () => {
      let runningVersion = NONTHUB_FALLBACK_VERSION;
      try {
        runningVersion = cleanVersion(await invoke<string>("get_nonthub_runtime_version")) || NONTHUB_FALLBACK_VERSION;
        setNontHubVersion(runningVersion);
      } catch (error) {
        console.warn("Could not read the runtime NontHub version; using build fallback", error);
      }
      // Catalog-backed apps are refreshed by the catalog-wide version effect below.
    })();

    const downloadUnlisten = listen<DownloadProgressPayload>("download-progress", (event) => {
      const payload = event.payload;
      setDownloads((current) => current.map((item) => item.id === payload.id ? {
        ...item,
        status: payload.status,
        receivedBytes: payload.received_bytes,
        totalBytes: payload.total_bytes ?? undefined,
        progress: payload.percent ?? (payload.status === "complete" ? 100 : item.progress),
        path: payload.path ?? item.path,
        error: payload.error ?? undefined,
      } : item));
    });


    return () => {
      downloadUnlisten.then((unlisten) => unlisten());
    };
  }, []);


  useEffect(() => {
    if (!profileLoaded) return;
    const persistForLifecycle = () => {
      const profile = profileSnapshotRef.current;
      if (profile) void invoke("save_user_profile", { profile }).catch(() => undefined);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") persistForLifecycle();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", persistForLifecycle);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", persistForLifecycle);
    };
  }, [profileLoaded]);

  useEffect(() => {
    if (!initialRepoSyncDoneRef.current) return;
    for (const app of apps) {
      if (app.repository) void ensureRepositoryIcon(app.repository, app.id);
    }
  }, [apps, installedNont.installed]);

  useEffect(() => {
    if (!profileLoaded || !catalogReady || initialRepoSyncDoneRef.current) return;
    initialRepoSyncDoneRef.current = true;
    void refreshAllRepositoriesNow(true).finally(() => setInitialRepoSyncComplete(true));
  }, [profileLoaded, catalogReady]);

  useEffect(() => {
    if (!initialRepoSyncComplete || !apps.length) return;
    void refreshCatalogVersions();
  }, [apps, nonthubVersion, initialRepoSyncComplete]);

  useEffect(() => {
    localStorage.setItem("nonthub.theme", theme);
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      const resolved = theme === "system" ? (media.matches ? "bright" : "dark") : theme;
      document.documentElement.dataset.theme = resolved;
      const favicon = document.querySelector<HTMLLinkElement>("#nonthub-favicon");
      if (favicon) {
        const themeName = resolved === "bright" ? "light" : "dark";
        favicon.href = `/brand/nonthub-${themeName}-${brandIconShape}.png`;
      }
      const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
      if (themeColor) themeColor.content = resolved === "bright" ? "#f7f5fa" : "#0a0a0d";
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme, brandIconShape]);

  useEffect(() => {
    localStorage.setItem("nonthub.brandIconShape", brandIconShape);
    document.documentElement.dataset.brandIconShape = brandIconShape;
  }, [brandIconShape]);

  useEffect(() => { localStorage.setItem("nonthub.closeBehavior", closeBehavior); }, [closeBehavior]);

  useEffect(() => {
    localStorage.setItem("nonthub.downloads", JSON.stringify(downloads.slice(0, 120)));
  }, [downloads]);

  useEffect(() => {
    if (!profileLoaded) return;
    if (profileSaveTimerRef.current !== null) window.clearTimeout(profileSaveTimerRef.current);
    profileSaveTimerRef.current = window.setTimeout(() => {
      const profile = currentProfile();
      void invoke("save_user_profile", { profile })
        .then(() => setProfileStatus("saved"))
        .catch((error) => { console.error("Could not save NontHub profile", error); setProfileStatus("error"); });
    }, 350);
    return () => {
      if (profileSaveTimerRef.current !== null) window.clearTimeout(profileSaveTimerRef.current);
    };
  }, [profileLoaded, theme, brandIconShape, downloads, closeBehavior, syncedRepositories]);


  const visibleApps = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return apps;
    return apps.filter((app) => [app.name, app.subtitle, app.description, app.category].join(" ").toLowerCase().includes(normalized));
  }, [apps, query]);

  const activeCount = downloads.filter((item) => item.status === "downloading" || item.status === "queued").length;
  const historyCount = downloads.length - activeCount;
  const connectedRepoCount = new Set([NONTHUB_REPOSITORY.toLowerCase(), ...apps.map((app) => app.repository?.toLowerCase()).filter((repo): repo is string => Boolean(repo))]).size;
  const detectedGithubRepository = parseGithubRepository(directUrl);
  const selectedGithubAsset = githubAssets.find((asset) => asset.asset_id === selectedGithubAssetId);

  useEffect(() => {
    if (showDownloadDialog && detectedGithubRepository) {
      void ensureRepositoryIcon(detectedGithubRepository, null);
    }
  }, [showDownloadDialog, detectedGithubRepository]);

  useEffect(() => {
    for (const item of downloads) {
      if (item.repository) void ensureRepositoryIcon(item.repository, item.appId ?? null);
    }
  }, [downloads.length]);

  useEffect(() => {
    if (!showDownloadDialog || !detectedGithubRepository) {
      setGithubAssets([]);
      setGithubAssetsError("");
      setSelectedGithubAssetId(null);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setGithubAssetsBusy(true);
      setGithubAssetsError("");
      try {
        const assets = await invoke<ResolvedAsset[]>("list_github_release_assets", { repository: detectedGithubRepository });
        if (cancelled) return;
        setGithubAssets(assets);
        const platformExts = packageExtensions("auto").map((ext) => ext.toLowerCase());
        const preferred = assets.find((asset) => platformExts.some((ext) => asset.name.toLowerCase().endsWith(ext)))
          ?? assets.find((asset) => !/\.(md5|sha1|sha256|sha512)(sum)?$/i.test(asset.name))
          ?? assets[0];
        setSelectedGithubAssetId(preferred?.asset_id ?? null);
      } catch (error) {
        if (!cancelled) {
          setGithubAssets([]);
          setSelectedGithubAssetId(null);
          setGithubAssetsError(String(error));
        }
      } finally {
        if (!cancelled) setGithubAssetsBusy(false);
      }
    }, 300);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [showDownloadDialog, detectedGithubRepository]);

  useEffect(() => {
    if (!showDownloadDialog || !detectedGithubRepository) {
      setGithubRepoInfo(null);
      setGithubRepoInfoBusy(false);
      return;
    }

    let cancelled = false;
    setGithubRepoInfo(null);
    const timer = window.setTimeout(async () => {
      setGithubRepoInfoBusy(true);
      try {
        const info = await invoke<GithubRepositoryInfo>("get_github_repository_info", { repository: detectedGithubRepository });
        if (!cancelled) setGithubRepoInfo(info);
      } catch (error) {
        if (!cancelled) {
          setGithubRepoInfo(null);
          console.warn(`Could not read repository metadata for ${detectedGithubRepository}`, error);
        }
      } finally {
        if (!cancelled) setGithubRepoInfoBusy(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [showDownloadDialog, detectedGithubRepository]);

  async function ensureRepositoryIcon(repository: string, appId?: string | null, force = false) {
    if (!repository || (!force && repoIcons[repository])) return;
    try {
      const dataUrl = await invoke<string | null>("resolve_repository_icon", { repository, appId: appId ?? null });
      if (dataUrl) setRepoIcons((current) => ({ ...current, [repository]: dataUrl }));
    } catch (error) {
      console.debug(`No repository icon found for ${repository}`, error);
    }
  }

  async function syncRepository(repository: string, knownInfo?: GithubRepositoryInfo | null) {
    const catalogMatch = catalogApps.find((app) => app.repository?.toLowerCase() === repository.toLowerCase());
    if (catalogMatch) {
      try {
        const info = knownInfo?.full_name.toLowerCase() === repository.toLowerCase()
          ? knownInfo
          : await invoke<GithubRepositoryInfo>("get_github_repository_info", { repository });
        setCatalogApps((current) => current.map((app) => app.repository?.toLowerCase() === repository.toLowerCase()
          ? { ...app, description: info.description?.trim() || app.description, version: info.latest_version ?? app.version }
          : app));
      } catch (error) {
        console.warn(`Could not refresh ${repository}`, error);
      }
      await ensureRepositoryIcon(repository, catalogMatch.id, true);
      return catalogMatch;
    }

    let synced: SyncedRepository;
    try {
      const info = knownInfo?.full_name.toLowerCase() === repository.toLowerCase()
        ? knownInfo
        : await invoke<GithubRepositoryInfo>("get_github_repository_info", { repository });
      synced = repositoryToSynced(info);
    } catch (error) {
      const message = String(error);
      if (/HTTP\s+(404|422)/i.test(message)) throw error;
      console.warn(`Could not fully sync ${repository}; keeping the repository as a source`, error);
      const [owner, name] = repository.split("/");
      synced = {
        repository,
        app_id: syncedAppId(repository),
        name,
        subtitle: `${owner} · GitHub`,
        description: `Synced directly with ${repository}.`,
        category: "GitHub",
        html_url: `https://github.com/${repository}`,
        synced_at: new Date().toISOString(),
      };
    }

    setSyncedRepositories((current) => [
      synced,
      ...current.filter((item) => item.repository.toLowerCase() !== synced.repository.toLowerCase()),
    ].slice(0, 100));
    await ensureRepositoryIcon(synced.repository, synced.app_id);
    return {
      id: synced.app_id, name: synced.name, subtitle: synced.subtitle, description: synced.description,
      category: synced.category, kind: "github-release" as const, repository: synced.repository,
      version: synced.latest_version ?? undefined, synced: true,
    };
  }

  async function refreshAllRepositoriesNow(silent = false) {
    if (repoSyncBusy) return;

    const repositories = new Map<string, { repository: string; appId: string; catalog: boolean }>();
    for (const app of catalogApps) {
      if (!app.repository) continue;
      repositories.set(app.repository.toLowerCase(), { repository: app.repository, appId: app.id, catalog: true });
    }
    for (const item of syncedRepositories) {
      const key = item.repository.toLowerCase();
      if (!repositories.has(key)) repositories.set(key, { repository: item.repository, appId: item.app_id, catalog: false });
    }
    if (!repositories.size) return;

    setRepoSyncBusy(true);
    try {
      const customByRepository = new Map(syncedRepositories.map((item) => [item.repository.toLowerCase(), item]));
      const catalogMetadata = new Map<string, GithubRepositoryInfo>();

      for (const source of repositories.values()) {
        try {
          const info = await invoke<GithubRepositoryInfo>("get_github_repository_info", { repository: source.repository });
          if (source.catalog) catalogMetadata.set(source.repository.toLowerCase(), info);
          else customByRepository.set(source.repository.toLowerCase(), repositoryToSynced(info));
          await ensureRepositoryIcon(source.repository, source.appId, true);
        } catch (error) {
          if (!silent) console.warn(`Could not sync ${source.repository}`, error);
        }
      }

      if (catalogMetadata.size) {
        setCatalogApps((current) => current.map((app) => {
          if (!app.repository) return app;
          const info = catalogMetadata.get(app.repository.toLowerCase());
          if (!info) return app;
          return {
            ...app,
            description: info.description?.trim() || app.description,
            version: info.latest_version ?? app.version,
          };
        }));
      }
      setSyncedRepositories((current) => current.map((item) => customByRepository.get(item.repository.toLowerCase()) ?? item));
      if (!silent) await checkAllUpdates();
    } finally {
      setRepoSyncBusy(false);
    }
  }

  function removeSyncedRepository(repository: string) {
    setSyncedRepositories((current) => current.filter((item) => item.repository.toLowerCase() !== repository.toLowerCase()));
  }

  function setCatalogReleaseCheck(appId: string, check: ReleaseCheck) {
    setAppReleaseChecks((current) => ({ ...current, [appId]: check }));
    if (appId === "nont") setNontRelease(check);
  }

  async function refreshCatalogVersions() {
    const nextInstalled: Record<string, InstalledAppInfo> = {};
    const githubApps = apps.filter((app) => app.kind === "github-release" && app.repository);

    for (const app of apps) {
      if (app.kind === "builtin") {
        nextInstalled[app.id] = { app_id: app.id, installed: true, version: nonthubVersion };
        continue;
      }
      if (app.kind !== "github-release") continue;
      try {
        const info = await invoke<InstalledAppInfo>("get_installed_app", { appId: app.id });
        nextInstalled[app.id] = info;
        if (app.id === "nont") setInstalledNont(info);
      } catch {
        const info: InstalledAppInfo = { app_id: app.id, installed: false };
        nextInstalled[app.id] = info;
        if (app.id === "nont") setInstalledNont(info);
      }
    }

    setInstalledApps((current) => ({ ...current, ...nextInstalled }));

    await Promise.all(githubApps.map(async (app) => {
      const info: InstalledAppInfo = nextInstalled[app.id] ?? { app_id: app.id, installed: false };
      const extensions = info.installed
        ? installedAppExtensions(info, app.assetExtensions ?? packageExtensions("auto"))
        : (app.assetExtensions ?? packageExtensions("auto"));
      await checkRelease(
        app.repository!,
        extensions,
        info.version,
        (check) => setCatalogReleaseCheck(app.id, check),
        info.asset_name,
        info,
      );
    }));

    await checkRelease(NONTHUB_REPOSITORY, packageExtensions("auto"), nonthubVersion, setNontHubRelease);
  }

  function catalogAppInfo(app: NontHubApp): InstalledAppInfo | undefined {
    if (app.kind === "builtin") return { app_id: app.id, installed: true, version: nonthubVersion };
    if (app.id === "nont") return installedApps[app.id] ?? installedNont;
    return installedApps[app.id];
  }

  function catalogAppVersion(app: NontHubApp) {
    if (app.kind === "builtin") return nonthubVersion;
    const info = catalogAppInfo(app);
    if (info?.installed) return cleanVersion(info.version) || "Installed";
    return app.version ? cleanVersion(app.version) : "";
  }

  async function addDownload(url: string, preferredName?: string, extra?: Partial<DownloadItem>, navigateToDownloads = true) {
    const id = crypto.randomUUID();
    const guessedName = preferredName || filenameFromUrl(url);
    const item: DownloadItem = { id, name: guessedName, url, status: "downloading", progress: 0, receivedBytes: 0, ...extra };
    setDownloads((current) => [item, ...current]);
    if (navigateToDownloads) setPage("downloads");

    try {
      const path = await invoke<string>("download_file", { id, url, preferredName: guessedName });
      setDownloads((current) => current.map((download) => download.id === id ? { ...download, status: "complete", progress: 100, path } : download));
      return path;
    } catch (error) {
      const failure = downloadErrorState(error);
      setDownloads((current) => current.map((download) => download.id === id ? { ...download, ...failure } : download));
      throw error;
    }
  }

  async function installNont() {
    setInstallBusy(true);
    const id = crypto.randomUUID();
    setDownloads((current) => [{
      id,
      appId: "nont",
      name: installedNont.installed ? "Updating NONT Music" : "Installing NONT Music",
      url: `github://${NONT_REPOSITORY}/releases`,
      repository: NONT_REPOSITORY,
      packageType: installedNont.package_type ?? undefined,
      status: "downloading",
      progress: 0,
      receivedBytes: 0,
    }, ...current]);

    try {
      const extensions = installedNont.installed
        ? installedAppExtensions(installedNont, packageExtensions("auto"))
        : packageExtensions("auto");
      const info = await invoke<InstalledAppInfo>("install_github_app", {
        id,
        appId: "nont",
        repository: NONT_REPOSITORY,
        extensions,
      });
      setInstalledNont(info);
      setInstalledApps((current) => ({ ...current, nont: info }));
      setDownloads((current) => current.map((item) => item.id === id ? {
        ...item,
        name: info.asset_name ?? "NONT Music",
        packageType: info.package_type ?? "exe",
        status: "complete",
        progress: 100,
        path: info.executable_path ?? undefined,
      } : item));
    } catch (error) {
      const failure = downloadErrorState(error);
      setDownloads((current) => current.map((item) => item.id === id ? { ...item, ...failure } : item));
      if (failure.status !== "cancelled") setNontRelease({ status: "error", message: String(error) });
    } finally {
      setInstallBusy(false);
    }
  }

  async function launchNont() {
    try { await invoke("launch_installed_app", { appId: "nont" }); }
    catch (error) { console.error("Could not launch NONT Music", error); }
  }

  async function installCatalogGithubApp(app: NontHubApp) {
    if (!app.repository) return;
    const currentInfo: InstalledAppInfo = catalogAppInfo(app) ?? { app_id: app.id, installed: false };
    setAppInstallBusy((current) => ({ ...current, [app.id]: true }));
    const id = crypto.randomUUID();
    setDownloads((current) => [{
      id,
      appId: app.id,
      name: currentInfo.installed ? `Updating ${app.name}` : `Installing ${app.name}`,
      url: `github://${app.repository}/releases`,
      repository: app.repository,
      packageType: currentInfo.package_type ?? undefined,
      status: "downloading",
      progress: 0,
      receivedBytes: 0,
    }, ...current]);
    try {
      const extensions = currentInfo.installed
        ? installedAppExtensions(currentInfo, app.assetExtensions ?? packageExtensions("auto"))
        : (app.assetExtensions ?? packageExtensions("auto"));
      const info = await invoke<InstalledAppInfo>("install_github_app", {
        id,
        appId: app.id,
        repository: app.repository,
        extensions,
      });
      setInstalledApps((current) => ({ ...current, [app.id]: info }));
      if (app.id === "nont") setInstalledNont(info);
      setDownloads((current) => current.map((item) => item.id === id ? {
        ...item,
        name: info.asset_name ?? app.name,
        packageType: info.package_type ?? item.packageType,
        status: "complete",
        progress: 100,
        path: info.executable_path ?? undefined,
      } : item));
      await checkRelease(
        app.repository,
        installedAppExtensions(info, app.assetExtensions ?? packageExtensions("auto")),
        info.version,
        (check) => setCatalogReleaseCheck(app.id, check),
        info.asset_name,
        info,
      );
    } catch (error) {
      const failure = downloadErrorState(error);
      setDownloads((current) => current.map((item) => item.id === id ? { ...item, ...failure } : item));
      if (failure.status !== "cancelled") setCatalogReleaseCheck(app.id, { status: "error", message: String(error) });
    } finally {
      setAppInstallBusy((current) => ({ ...current, [app.id]: false }));
    }
  }

  async function launchCatalogApp(app: NontHubApp) {
    try { await invoke("launch_installed_app", { appId: app.id }); }
    catch (error) { console.error(`Could not launch ${app.name}`, error); }
  }

  async function installApp(app: NontHubApp) {
    if (app.kind === "builtin") {
      setPage("downloads");
      return;
    }
    if (app.kind === "direct" && app.downloadUrl) { await addDownload(app.downloadUrl); return; }
    if (app.kind === "github-release" && app.repository) {
      const info = catalogAppInfo(app);
      if (info?.installed) await launchCatalogApp(app);
      else await installCatalogGithubApp(app);
    }
  }

  async function cancelDownload(id: string) {
    try { await invoke("cancel_download", { id }); }
    catch (error) { console.error(error); }
  }

  function clearDownloadHistory() {
    setDownloads((current) => current.filter((item) => item.status === "downloading" || item.status === "queued"));
  }

  async function submitDirectDownload(event: FormEvent) {
    event.preventDefault();
    const url = directUrl.trim();
    const repository = parseGithubRepository(url);
    if ((!repository && !/^https:\/\//i.test(url)) || addBusy) return;
    setAddBusy(true);

    try {
      if (repository) {
        await syncRepository(repository, githubRepoInfo);
        if (githubAction === "download") {
          if (!selectedGithubAsset) {
            throw new Error(githubAssetsError || "Choose a release asset to download.");
          }
          setShowDownloadDialog(false);
          setDirectUrl("");
          await addDownload(selectedGithubAsset.download_url, selectedGithubAsset.name, {
            repository,
            packageType: selectedGithubAsset.package_type,
          });
        } else {
          const extensions = packageExtensions(githubTarget);
          const asset = await invoke<ResolvedAsset>("resolve_github_release", { repository, extensions, preferredAssetName: null });
          setShowDownloadDialog(false);
          setDirectUrl("");
          const path = await addDownload(asset.download_url, asset.name, { repository, packageType: asset.package_type });
          if (["exe", "msi"].includes(asset.package_type)) {
            await invoke("run_downloaded_installer", { path });
          }
        }
      } else {
        setShowDownloadDialog(false);
        setDirectUrl("");
        await addDownload(url);
      }
    } catch (error) {
      console.error("Could not add download", error);
    } finally {
      setAddBusy(false);
    }
  }

  async function checkRelease(repository: string, extensions: string[], currentVersion?: string | null, setter?: (check: ReleaseCheck) => void, preferredAssetName?: string | null, installedInfo?: InstalledAppInfo | null) {
    const set = setter ?? (() => undefined);
    set({ status: "checking" });
    try {
      const asset = await invoke<ResolvedAsset>("resolve_github_release", { repository, extensions, preferredAssetName: preferredAssetName ?? null });
      const latest = cleanVersion(asset.version);
      const current = cleanVersion(currentVersion);
      const comparison = current ? compareVersions(latest, current) : null;
      const changedAsset = installedAssetChanged(asset, installedInfo);
      const available = !current || comparison === 1 || changedAsset;
      let message: string | undefined;
      if (changedAsset && comparison !== 1) {
        message = "The release asset changed even though its version is not newer. Reinstall/update is available.";
      } else if (current && comparison === 0) {
        message = `You are already using the newest version (v${current}).`;
      } else if (current && comparison === -1) {
        message = `You are running v${current}, which is newer than the published v${latest}. No update is needed.`;
      } else if (current && comparison === null) {
        message = `Could not safely compare v${current} with release label ${asset.version}. NontHub will not claim an update is available.`;
      }
      set({
        status: available ? "available" : "current",
        version: latest,
        asset,
        message,
      });
    } catch (error) {
      const message = String(error);
      if (message.toLowerCase().includes("no published github releases")) set({ status: "unreleased", message });
      else set({ status: "error", message });
    }
  }

  async function checkAllUpdates() {
    const githubChecks = apps
      .filter((app) => app.kind === "github-release" && app.repository)
      .map((app) => {
        const info: InstalledAppInfo = catalogAppInfo(app) ?? { app_id: app.id, installed: false };
        const extensions = info.installed
          ? installedAppExtensions(info, app.assetExtensions ?? packageExtensions("auto"))
          : (app.assetExtensions ?? packageExtensions("auto"));
        return checkRelease(
          app.repository!,
          extensions,
          info.version,
          (check) => setCatalogReleaseCheck(app.id, check),
          info.asset_name,
          info,
        );
      });
    await Promise.all([
      ...githubChecks,
      checkRelease(NONTHUB_REPOSITORY, packageExtensions("auto"), nonthubVersion, setNontHubRelease),
    ]);
  }

  async function downloadNontHubUpdate() {
    if (!nonthubRelease.asset) return;
    setNontHubRelease((current) => ({ ...current, status: "checking", message: "Downloading and installing update…" }));
    try {
      const path = await addDownload(nonthubRelease.asset.download_url, nonthubRelease.asset.name, { repository: NONTHUB_REPOSITORY, packageType: nonthubRelease.asset.package_type }, false);
      await persistProfileNow();
      await invoke("install_nonthub_update", { path });
    } catch (error) {
      setNontHubRelease((current) => ({ ...current, status: "error", message: String(error) }));
    }
  }



  async function finishCloseChoice(choice: "minimize" | "exit") {
    const remembered: CloseBehavior = rememberCloseChoice ? choice : "ask";
    if (rememberCloseChoice) {
      localStorage.setItem("nonthub.closeBehavior", choice);
      setCloseBehavior(choice);
    }
    try {
      await invoke("save_user_profile", { profile: { ...currentProfile(), close_behavior: remembered } });
      setProfileStatus("saved");
    } catch (error) {
      console.error("Could not save close preference", error);
    }
    setShowCloseChoice(false);
    if (choice === "minimize") await invoke("hide_main_window");
    else await invoke("exit_nonthub");
  }

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    void getCurrentWindow().onCloseRequested(async (event) => {
      event.preventDefault();
      const saved = (localStorage.getItem("nonthub.closeBehavior") as CloseBehavior | null) ?? "ask";
      if (saved === "minimize") {
        await invoke("hide_main_window");
        return;
      }
      if (saved === "exit") {
        const snapshot = profileSnapshotRef.current;
        if (snapshot) {
          try { await invoke("save_user_profile", { profile: snapshot }); } catch { /* best effort on close */ }
        }
        await invoke("exit_nonthub");
        return;
      }
      setRememberCloseChoice(true);
      setShowCloseChoice(true);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return (
    <div className="shell windows-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => setPage("home")}>
          <span className="brand-mark"><NontHubLogo size={29} /></span>
          <span className="brand-copy"><strong>NONTHUB</strong><small>WINDOWS HUB</small></span>
        </button>

        <div className="sidebar-label">NONTHUB</div>
        <nav>
          {nav.map(({ page: itemPage, label, icon: Icon }) => (
            <button key={itemPage} className={page === itemPage ? "nav-item active" : "nav-item"} onClick={() => setPage(itemPage)}>
              <Icon size={18} /><span>{label}</span>
              {itemPage === "downloads" && activeCount > 0 && <b className="badge">{activeCount}</b>}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="mini-now-playing">
            <div className="mini-art">{repoIcons[NONT_REPOSITORY] ? <img src={repoIcons[NONT_REPOSITORY]} alt="NONT Music" /> : <Music2 size={17} />}</div>
            <div><strong>NONT Music</strong><span>{installedNont.installed ? "Ready to play" : "Not installed"}</span></div>
            <button onClick={() => installedNont.installed ? void launchNont() : void installNont()} aria-label="Open NONT Music"><ChevronRight size={17} /></button>
          </div>
          <div className="status-pill"><span /> NontHub online</div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="search-box"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search NontHub library" /></div>
          <div className="topbar-actions">
            <ThemeQuickToggle theme={theme} onChange={setTheme} />
            <button className="primary compact add-download-button" onClick={() => setShowDownloadDialog(true)}><Plus size={17} /><span>Add download</span></button>
          </div>
        </header>

        {page === "home" && (
          <section className="content">
            <div className="hero nonthub-hero">
              <div className="hero-copy">
                <div className="eyebrow"><span className="eyebrow-dot" /> GITHUB APP HUB</div>
                <h1>Everything you install.<br /><em>One clean place.</em></h1>
                <p>A focused Windows hub for NONT Music, Veil Browser and every GitHub repository you connect. Install, launch and update without the clutter.</p>
                <div className="hero-actions">
                  <button className="primary" onClick={() => setPage("library")}><Boxes size={18} /> Open library</button>
                  <button className="secondary" onClick={() => void openOfficialWebsite(NONTHUB_WEBSITE)}><ExternalLink size={17} /> Website</button>
                </div>
              </div>
              <div className="signal-stage" aria-hidden="true">
                <div className="signal-ring ring-one" /><div className="signal-ring ring-two" />
                <div className="signal-core"><NontHubLogo size={54} /></div>
                <div className="waveform">{Array.from({ length: 21 }).map((_, i) => <i key={i} style={{ height: `${18 + ((i * 17) % 48)}px` }} />)}</div>
              </div>
            </div>

            <div className="home-split">
              <div>
                <SectionTitle title="Featured" subtitle="Your pinned apps and connected Windows releases." />
                <div className="app-grid featured-grid">
                  {visibleApps.filter((app) => app.featured).map((app) => <AppCard key={app.id} app={app} installed={catalogAppInfo(app)?.installed} version={catalogAppVersion(app)} busy={Boolean(appInstallBusy[app.id]) || (app.id === "nont" && installBusy)} iconUrl={app.repository ? repoIcons[app.repository] : undefined} onOpen={() => void installApp(app)} onWebsite={app.website ? () => void openOfficialWebsite(app.website!) : undefined} />)}
                </div>
              </div>
              <aside className="activity-panel">
                <span className="category">STATUS</span><h3>At a glance</h3>
                <PulseRow icon={<Music2 size={16} />} label="NONT Music" value={installedNont.installed ? `Installed ${cleanVersion(installedNont.version) || ""}` : "Ready to install"} />
                <PulseRow icon={<Download size={16} />} label="Downloads" value={`${activeCount} active`} />
                <PulseRow icon={<Globe2 size={16} />} label="Veil Browser" value={catalogAppInfo(apps.find((app) => app.id === "veil-browser") ?? { id: "veil-browser", name: "Veil Browser", subtitle: "", description: "", category: "Web", kind: "github-release", repository: VEIL_REPOSITORY })?.installed ? "Installed" : "Ready to install"} />
                <button className="ghost-link" onClick={() => { setInstallerMode("update"); setPage("installer"); }}>Open installer <ChevronRight size={15} /></button>
              </aside>
            </div>
          </section>
        )}

        {page === "library" && (
          <section className="content"><SectionTitle title="Library" subtitle="GitHub repositories you add are saved here and kept in sync with their source." /><div className="app-grid">{visibleApps.map((app) => <AppCard key={app.id} app={app} installed={catalogAppInfo(app)?.installed} version={catalogAppVersion(app)} busy={Boolean(appInstallBusy[app.id]) || (app.id === "nont" && installBusy)} iconUrl={app.repository ? repoIcons[app.repository] : undefined} onOpen={() => void installApp(app)} onWebsite={app.website ? () => void openOfficialWebsite(app.website!) : undefined} />)}</div></section>
        )}

        {page === "downloads" && (
          <section className="content">
            <SectionTitle title="Downloads" subtitle="Direct files and GitHub Release assets in one history." action={<div className="section-actions"><button className="secondary compact" onClick={clearDownloadHistory} disabled={historyCount === 0}><Trash2 size={16} /> Clear history</button><button className="secondary compact" onClick={() => setShowDownloadDialog(true)}><Plus size={16} /> New</button></div>} />
            {downloads.length === 0 ? <EmptyState onAdd={() => setShowDownloadDialog(true)} /> : (
              <div className="downloads-list">{downloads.map((item) => (
                <div className="download-row" key={item.id}>
                  <div className="download-icon">{item.repository && repoIcons[item.repository] ? <img src={repoIcons[item.repository]} alt="" /> : item.status === "complete" ? <CheckCircle2 size={21} /> : (item.status === "failed" || item.status === "cancelled") ? <XCircle size={21} /> : <Download size={21} />}</div>
                  <div className="download-info">
                    <div className="download-title"><strong>{item.name}</strong><span>{item.status}{item.packageType ? ` · .${item.packageType}` : ""}</span></div>
                    <div className="progress-track"><span style={{ width: `${Math.max(0, Math.min(100, item.progress))}%` }} /></div>
                    <div className="download-meta"><span>{formatBytes(item.receivedBytes)}{item.totalBytes ? ` / ${formatBytes(item.totalBytes)}` : ""}</span><span>{Math.round(item.progress)}%</span></div>
                    {item.repository && <small className="path">GitHub · {item.repository}</small>}
                    {item.path && <small className="path">Saved to {displayPath(item.path)}</small>}
                    {item.error && <small className="error">{item.error}</small>}
                  </div>
                  {item.status === "downloading" && <button className="icon-button" title="Cancel" onClick={() => void cancelDownload(item.id)}><X size={17} /></button>}
                </div>
              ))}</div>
            )}
          </section>
        )}

        {page === "installer" && (() => {
          const githubApps = apps.filter((app) => app.kind === "github-release" && app.repository);
          const installApps = githubApps.filter((app) => !catalogAppInfo(app)?.installed);
          const updateApps = githubApps.filter((app) => catalogAppInfo(app)?.installed);
          const showingInstall = installerMode === "install";
          const visibleInstallerApps = showingInstall ? installApps : updateApps;
          return (
            <section className="content installer-page">
              <SectionTitle
                title="Installer"
                subtitle="Install new apps or keep installed apps current. Actions start immediately with no NontHub confirmation dialogs."
                action={<button className="secondary compact" onClick={() => void checkAllUpdates()}><RefreshCw size={16} /> Refresh</button>}
              />
              <div className="installer-mode segmented" role="tablist" aria-label="Installer mode">
                <button type="button" role="tab" aria-selected={showingInstall} className={showingInstall ? "active" : ""} onClick={() => setInstallerMode("install")}><PackageOpen size={16} /> Install <span>{installApps.length}</span></button>
                <button type="button" role="tab" aria-selected={!showingInstall} className={!showingInstall ? "active" : ""} onClick={() => setInstallerMode("update")}><RefreshCw size={16} /> Update <span>{updateApps.length + 1}</span></button>
              </div>
              <div className="compat-banner"><ShieldCheck size={20} /><div><strong>One-click Windows flow</strong><p>NontHub resolves the compatible Windows package and starts the install or update immediately. Windows UAC or a third-party installer may still appear when required by Windows.</p></div></div>
              <div className="update-stack">
                {!showingInstall && <UpdateCard icon={<NontHubLogo size={64} />} name="NontHub" repository={NONTHUB_REPOSITORY} currentVersion={nonthubVersion} check={nonthubRelease} primaryLabel={nonthubRelease.status === "current" ? "Up to date" : "Update NontHub"} onPrimary={() => void downloadNontHubUpdate()} busy={nonthubRelease.status === "checking" && /installing|downloading/i.test(nonthubRelease.message ?? "")} disabled={!nonthubRelease.asset || nonthubRelease.status !== "available"} />}
                {visibleInstallerApps.map((app) => {
                  const info: InstalledAppInfo = catalogAppInfo(app) ?? { app_id: app.id, installed: false };
                  const check = appReleaseChecks[app.id] ?? { status: "idle" as UpdateStatus };
                  const isBusy = Boolean(appInstallBusy[app.id]) || (app.id === "nont" && installBusy);
                  const primaryLabel = showingInstall ? `Install ${app.name}` : check.status === "current" ? "Up to date" : `Update ${app.name}`;
                  const disabled = showingInstall ? isBusy : isBusy || check.status === "checking" || check.status !== "available";
                  return <UpdateCard
                    key={app.id}
                    icon={app.repository && repoIcons[app.repository] ? <img className="update-app-icon" src={repoIcons[app.repository]} alt={app.name} /> : <AppGlyph app={app} size={23} />}
                    name={app.name}
                    repository={app.repository!}
                    currentVersion={info.installed ? cleanVersion(info.version) || "Installed" : "Not installed"}
                    check={check}
                    primaryLabel={primaryLabel}
                    onPrimary={() => void installCatalogGithubApp(app)}
                    busy={isBusy}
                    disabled={disabled}
                  />;
                })}
                {visibleInstallerApps.length === 0 && showingInstall && <div className="installer-empty"><CheckCircle2 size={24} /><div><strong>Everything here is installed</strong><span>Add another GitHub repository from Library or Downloads when you want more apps.</span></div></div>}
                {visibleInstallerApps.length === 0 && !showingInstall && <div className="installer-empty"><CheckCircle2 size={24} /><div><strong>No installed apps to update</strong><span>Install an app first, then it will appear here automatically.</span></div></div>}
              </div>
            </section>
          );
        })()}

        {page === "settings" && (
          <section className="content settings-page">
            <SectionTitle title="Settings" subtitle="Appearance, close behavior and installer behavior." />
            <SettingsSection icon={<Sun size={19} />} title="Appearance" subtitle="NontHub automatically swaps the matte logo for dark or light mode. Choose whether the icon is rounded-square or circular.">
              <div className="appearance-stack">
                <div className="theme-grid">
                  <ThemeChoice mode="dark" active={theme === "dark"} icon={<Moon size={20} />} label="Dark" onClick={() => setTheme("dark")} />
                  <ThemeChoice mode="bright" active={theme === "bright"} icon={<Sun size={20} />} label="Light" onClick={() => setTheme("bright")} />
                  <ThemeChoice mode="system" active={theme === "system"} icon={<Monitor size={20} />} label="System" onClick={() => setTheme("system")} />
                </div>
                <div className="brand-icon-settings">
                  <div className="brand-icon-settings-copy"><strong>Icon shape</strong><small>The dark/light artwork follows your selected theme automatically.</small></div>
                  <div className="brand-icon-grid">
                    <BrandIconChoice shape="rounded" active={brandIconShape === "rounded"} label="Rounded" onClick={() => setBrandIconShape("rounded")} />
                    <BrandIconChoice shape="circle" active={brandIconShape === "circle"} label="Circle" onClick={() => setBrandIconShape("circle")} />
                  </div>
                </div>
              </div>
            </SettingsSection>

            <SettingsSection icon={<Power size={19} />} title="Close behavior" subtitle="Choose what the window X button does. NontHub can keep downloads and tray access available in the background, or quit completely.">
              <div className="close-behavior-grid">
                <button className={closeBehavior === "ask" ? "close-behavior active" : "close-behavior"} onClick={() => setCloseBehavior("ask")}><Settings size={19} /><div><strong>Ask me</strong><small>Show the choice when I close NontHub.</small></div>{closeBehavior === "ask" && <Check size={15} />}</button>
                <button className={closeBehavior === "minimize" ? "close-behavior active" : "close-behavior"} onClick={() => setCloseBehavior("minimize")}><Minimize2 size={19} /><div><strong>Minimize to tray</strong><small>Hide NontHub but keep it running.</small></div>{closeBehavior === "minimize" && <Check size={15} />}</button>
                <button className={closeBehavior === "exit" ? "close-behavior active" : "close-behavior"} onClick={() => setCloseBehavior("exit")}><Power size={19} /><div><strong>Exit completely</strong><small>Close NontHub and its background process.</small></div>{closeBehavior === "exit" && <Check size={15} />}</button>
              </div>
            </SettingsSection>




            <SettingsSection icon={<ShieldCheck size={19} />} title="Persistent profile" subtitle="Updates replace NontHub program files only. Your personal settings stay outside the install folder and are restored automatically."><SettingRow title="Profile" description="Theme, icon shape, download history and close preferences survive reinstall/update cycles." value={profileStatus === "saved" ? "Saved" : profileStatus === "loading" ? "Loading…" : "Save issue"} /></SettingsSection>

            <SettingsSection icon={<RefreshCw size={19} />} title="Release sources" subtitle="GitHub is the source of truth. Repositories you add are saved to your Library and refreshed from GitHub automatically.">
              <SettingRow title="NONT Music" description="Uses the matching Windows package family and installed app." value={`${NONT_REPOSITORY} · music.nont.me`} />
              <SettingRow title="Veil Browser" description="Uses the newest compatible Windows Veil Browser release." value={VEIL_REPOSITORY} />
              <SettingRow title="NontHub" description="Uses the matching Windows NontHub package." value={`${NONTHUB_REPOSITORY} · www.nont.me`} />
              <div className="synced-sources-heading"><div><strong>Connected repositories</strong><small>{`${connectedRepoCount} repos connected`}</small></div><button className="secondary compact" type="button" disabled={!apps.some((app) => app.repository) || repoSyncBusy} onClick={() => void refreshAllRepositoriesNow()}>{repoSyncBusy ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />} Sync all</button></div>
              {syncedRepositories.length > 0 && <div className="synced-source-list">{syncedRepositories.map((item) => <div className="synced-source-row" key={item.repository}><div className="synced-source-icon">{repoIcons[item.repository] ? <img src={repoIcons[item.repository]} alt="" /> : <PackageOpen size={17} />}</div><div><strong>{item.name}</strong><small>{item.repository}{item.latest_version ? ` · v${cleanVersion(item.latest_version)}` : ""}</small></div><button type="button" className="icon-button danger" title="Remove from synced Library" onClick={() => removeSyncedRepository(item.repository)}><Trash2 size={15} /></button></div>)}</div>}
            </SettingsSection>

            <SettingsSection icon={<Globe2 size={19} />} title="Official websites" subtitle="Open the official NontHub and NONT Music sites in your default browser.">
              <div className="website-setting-list">
                <button className="website-setting-row" type="button" onClick={() => void openOfficialWebsite(NONTHUB_WEBSITE)}><div><strong>NontHub</strong><small>www.nont.me</small></div><ExternalLink size={16} /></button>
                <button className="website-setting-row" type="button" onClick={() => void openOfficialWebsite(NONT_MUSIC_WEBSITE)}><div><strong>NONT Music</strong><small>music.nont.me</small></div><ExternalLink size={16} /></button>
              </div>
            </SettingsSection>
          </section>
        )}
      </main>


      {showCloseChoice && (
        <div className="modal-backdrop close-choice-backdrop">
          <div className="modal close-choice-modal" role="dialog" aria-modal="true" aria-labelledby="close-choice-title">
            <div className="modal-title"><div><small>FIRST CLOSE</small><h2 id="close-choice-title">What should NontHub do when you close it?</h2></div><button type="button" className="icon-button" onClick={() => setShowCloseChoice(false)}><X size={18} /></button></div>
            <p className="close-choice-copy">Choose once, or leave “Remember my choice” off to be asked again next time.</p>
            <div className="close-choice-actions">
              <button type="button" className="close-choice-action" onClick={() => void finishCloseChoice("minimize")}><span><Minimize2 size={24} /></span><div><strong>Minimize to tray</strong><small>NontHub stays running in the background and can be reopened from the tray icon.</small></div><ChevronRight size={18} /></button>
              <button type="button" className="close-choice-action danger-choice" onClick={() => void finishCloseChoice("exit")}><span><Power size={24} /></span><div><strong>Exit completely</strong><small>Close the NontHub window and stop the NontHub background process.</small></div><ChevronRight size={18} /></button>
            </div>
            <label className="remember-row"><input type="checkbox" checked={rememberCloseChoice} onChange={(event) => setRememberCloseChoice(event.target.checked)} /><span><strong>Remember my choice</strong><small>You can change this later in Settings → Close behavior.</small></span></label>
          </div>
        </div>
      )}

      {showDownloadDialog && (
        <div className="modal-backdrop" onMouseDown={() => !addBusy && setShowDownloadDialog(false)}>
          <form className="modal" onSubmit={submitDirectDownload} onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-title"><div><small>DOWNLOAD / INSTALL</small><h2>Add to NontHub</h2></div><button type="button" className="icon-button" onClick={() => setShowDownloadDialog(false)} disabled={addBusy}><X size={18} /></button></div>
            <label>Direct URL, GitHub URL, or owner/repo</label>
            <input autoFocus value={directUrl} onChange={(event) => setDirectUrl(event.target.value)} placeholder="voidnont/project or https://github.com/voidnont/project" />
            {detectedGithubRepository ? <>
              <div className="github-detected">{repoIcons[detectedGithubRepository] ? <img className="github-repo-icon" src={repoIcons[detectedGithubRepository]} alt="" /> : <ShieldCheck size={17} />}<div><strong>{githubRepoInfo?.name || (githubRepoInfoBusy ? "Reading GitHub repository…" : "GitHub repository detected")}</strong><span>{githubRepoInfo?.description || detectedGithubRepository}</span></div></div>
              <div className="sync-note"><RefreshCw size={15} /><div><strong>Synced with GitHub</strong><span>This repository will stay in your Library. NontHub refreshes its GitHub name, description, icon and latest release when the hub starts.</span></div></div>

              <label>What should NontHub do?</label>
              <div className="segmented github-action">
                <button type="button" className={githubAction === "download" ? "active" : ""} onClick={() => setGithubAction("download")}><Download size={15} /> Download asset</button>
                <button type="button" className={githubAction === "install" ? "active" : ""} onClick={() => setGithubAction("install")}><PackageOpen size={15} /> Install on Windows</button>
              </div>

              {githubAction === "download" ? <>
                <label>Release asset</label>
                {githubAssetsBusy ? <div className="asset-loading"><LoaderCircle size={16} className="spin" /> Reading release files…</div> : githubAssetsError ? <div className="asset-error">{githubAssetsError}</div> : (
                  <select className="field modal-select" value={selectedGithubAssetId ?? ""} onChange={(event) => setSelectedGithubAssetId(Number(event.target.value))}>
                    {githubAssets.map((asset) => <option key={asset.asset_id} value={asset.asset_id}>{asset.name} · {formatBytes(asset.asset_size)}{asset.prerelease ? " · prerelease" : ""}</option>)}
                  </select>
                )}
                {selectedGithubAsset && <p>NontHub will download exactly <strong>{selectedGithubAsset.name}</strong>. NontHub will download the selected release asset exactly as published.</p>}
              </> : <>
                <label>Compatible package</label>
                <select className="field modal-select" value={githubTarget} onChange={(event) => setGithubTarget(event.target.value as GithubPackageTarget)}>{installTargetOptions().map((target) => <option key={target} value={target}>{targetLabels[target]}</option>)}</select>
                <p>Package mode is strict: NontHub selects a Windows EXE/MSI package compatible with the current CPU architecture.</p>
              </>}
            </> : <p>HTTPS files download directly. Paste a GitHub URL or enter owner/repo to add that repository to your synced Library and browse its release assets.</p>}
            <button className="primary full" type="submit" disabled={addBusy || !directUrl.trim() || (Boolean(detectedGithubRepository) && githubAction === "download" && (!selectedGithubAsset || githubAssetsBusy))}>{addBusy ? <LoaderCircle size={18} className="spin" /> : detectedGithubRepository && githubAction === "install" ? <PackageOpen size={18} /> : <Download size={18} />} {detectedGithubRepository ? (githubAction === "install" ? "Resolve & install compatible asset" : "Download selected release asset") : "Start download"}</button>
          </form>
        </div>
      )}
    </div>
  );
}

function NontHubLogo({ size = 28 }: { size?: number }) {
  return <span className="nonthub-logo-frame" style={{ width: size, height: size }} aria-hidden="true">
    <img className="nonthub-logo-image nonthub-logo-variant variant-dark-rounded" src="/brand/nonthub-dark-rounded.png" alt="" draggable={false} />
    <img className="nonthub-logo-image nonthub-logo-variant variant-light-rounded" src="/brand/nonthub-light-rounded.png" alt="" draggable={false} />
    <img className="nonthub-logo-image nonthub-logo-variant variant-dark-circle" src="/brand/nonthub-dark-circle.png" alt="" draggable={false} />
    <img className="nonthub-logo-image nonthub-logo-variant variant-light-circle" src="/brand/nonthub-light-circle.png" alt="" draggable={false} />
  </span>;
}

function BrandIconPreview({ shape }: { shape: BrandIconShape }) {
  return <span className={`nonthub-logo-frame brand-icon-preview shape-${shape}`} aria-hidden="true">
    <img className="nonthub-logo-image nonthub-logo-variant variant-dark-rounded" src="/brand/nonthub-dark-rounded.png" alt="" draggable={false} />
    <img className="nonthub-logo-image nonthub-logo-variant variant-light-rounded" src="/brand/nonthub-light-rounded.png" alt="" draggable={false} />
    <img className="nonthub-logo-image nonthub-logo-variant variant-dark-circle" src="/brand/nonthub-dark-circle.png" alt="" draggable={false} />
    <img className="nonthub-logo-image nonthub-logo-variant variant-light-circle" src="/brand/nonthub-light-circle.png" alt="" draggable={false} />
  </span>;
}

function BrandIconChoice({ shape, active, label, onClick }: { shape: BrandIconShape; active: boolean; label: string; onClick: () => void }) {
  return <button className={active ? "brand-icon-choice active" : "brand-icon-choice"} onClick={onClick}>
    <BrandIconPreview shape={shape} />
    <span><strong>{label}</strong><small>{shape === "circle" ? "Circular app mark" : "Rounded app mark"}</small></span>
    {active && <Check size={16} />}
  </button>;
}

function ThemeQuickToggle({ theme, onChange }: { theme: ThemeMode; onChange: (mode: ThemeMode) => void }) {
  const next: ThemeMode = theme === "bright" ? "dark" : "bright";
  const nextLabel = next === "bright" ? "light" : "dark";
  return <button className="icon-button theme-toggle" title={`Switch to ${nextLabel} mode`} onClick={() => onChange(next)}>{theme === "bright" ? <Moon size={17} /> : <Sun size={17} />}</button>;
}

function SectionTitle({ title, subtitle, action }: { title: string; subtitle: string; action?: React.ReactNode }) {
  return <div className="section-title"><div><h2>{title}</h2><p>{subtitle}</p></div>{action}</div>;
}

function AppGlyph({ app, size = 27 }: { app: NontHubApp; size?: number }) {
  if (app.id === "veil-browser") return <Globe2 size={size} />;
  if (app.id === "custom-downloads") return <Download size={size} />;
  if (app.id === "nont") return <Music2 size={size} />;
  return <PackageOpen size={size} />;
}

function AppCard({ app, onOpen, onWebsite, installed, version, busy, iconUrl }: { app: NontHubApp; onOpen: () => void; onWebsite?: () => void; installed?: boolean; version?: string; busy?: boolean; iconUrl?: string }) {
  const label = busy ? "Working…" : app.kind === "builtin" ? "Open" : installed ? "Launch" : "Install";
  return <article className="app-card"><div className="app-card-top"><div className={`app-icon ${iconUrl ? "real-app-icon" : ""}`}>{iconUrl ? <img src={iconUrl} alt={`${app.name} icon`} /> : <AppGlyph app={app} />}</div><div className="app-card-chips">{app.synced && <span className="state-chip"><RefreshCw size={12} /> Synced</span>}{installed && app.kind !== "builtin" && <span className="state-chip good"><Check size={12} /> Installed</span>}{version && <span className="version-chip">v{version}</span>}</div></div><div className="app-copy"><span className="category">{app.category}</span><h3>{app.name}</h3><strong>{app.subtitle}</strong><p>{app.description}</p>{app.website && <button type="button" className="app-website-link" onClick={onWebsite}><Globe2 size={13} /> {app.website.replace(/^https?:\/\//, "")}</button>}</div><button className="secondary full" onClick={onOpen} disabled={busy}>{busy ? <LoaderCircle size={16} className="spin" /> : app.kind === "builtin" ? <ChevronRight size={16} /> : installed ? <Rocket size={16} /> : <PackageOpen size={16} />} {label}</button></article>;
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return <div className="empty"><div className="empty-icon"><Download size={27} /></div><h3>No downloads yet</h3><p>Install an app from the library, paste a direct file URL, or paste a GitHub repository.</p><button className="primary" onClick={onAdd}><Plus size={18} /> Add download</button></div>;
}

function PulseRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return <div className="pulse-row"><span className="pulse-icon">{icon}</span><div><strong>{label}</strong><small>{value}</small></div></div>;
}

function SettingRow({ title, description, value }: { title: string; description: string; value: string }) {
  return <div className="setting-row"><div><strong>{title}</strong><p>{description}</p></div><span>{value}</span></div>;
}

function SettingsSection({ icon, title, subtitle, children }: { icon: React.ReactNode; title: string; subtitle: string; children: React.ReactNode }) {
  return <section className="settings-section"><div className="settings-heading"><div className="settings-icon">{icon}</div><div><h3>{title}</h3><p>{subtitle}</p></div></div><div className="settings-body">{children}</div></section>;
}

function ThemeChoice({ active, icon, label, onClick }: { mode: ThemeMode; active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return <button className={active ? "theme-choice active" : "theme-choice"} onClick={onClick}><span>{icon}</span><strong>{label}</strong>{active && <Check size={16} />}</button>;
}

function BundledVersionCard({ icon, name, currentVersion, status = "Included with this NontHub build. It updates when NontHub updates." }: { icon: React.ReactNode; name: string; currentVersion: string; status?: string }) {
  return <article className="update-card bundled-version-card"><div className="update-icon">{icon}</div><div className="update-copy"><span className="category">APPLICATION VERSION</span><h3>{name}</h3><p>Built into NontHub</p><div className="version-line"><span>Current</span><strong>{currentVersion === "External" ? currentVersion : `v${currentVersion}`}</strong><i>→</i><span>Status</span><strong>Up to date with NontHub</strong></div><small className="muted">{status}</small></div><div className="update-actions"><span className="state-chip good"><Check size={12} /> Current</span></div></article>;
}

function UpdateCard({ icon, name, repository, currentVersion, check, primaryLabel, onPrimary, busy, disabled }: {
  icon: React.ReactNode; name: string; repository: string; currentVersion: string; check: ReleaseCheck; primaryLabel: string; onPrimary: () => void; busy?: boolean; disabled?: boolean;
}) {
  const statusText = check.status === "checking" ? (check.message || "Checking…") : check.status === "available" ? `Version ${check.version} available` : check.status === "current" ? `Current · v${check.version}` : check.status === "unreleased" ? "No release published yet" : check.status === "error" ? "Could not check" : "Ready";
  const working = Boolean(busy) || (check.status === "checking" && /installing|downloading/i.test(check.message ?? ""));
  return <article className={`update-card ${working ? "is-working" : ""}`}><div className="update-icon">{icon}</div><div className="update-copy"><span className="category">WINDOWS INSTALLER</span><h3>{name}</h3><p>{repository}</p><div className="version-line"><span>Current</span><strong>{currentVersion}</strong><i>→</i><span>Status</span><strong>{statusText}</strong></div>{check.asset && <small className="asset-line"><FileArchive size={12} /> {check.asset.name} · .{check.asset.package_type}{check.asset.prerelease ? " · prerelease" : ""} · {formatBytes(check.asset.asset_size)}</small>}{check.message && check.status === "error" && <small className="error">{check.message}</small>}</div><div className="update-actions"><button className="primary installer-primary" onClick={onPrimary} disabled={working || disabled}>{working ? <LoaderCircle size={16} className="spin" /> : <ArrowDownToLine size={16} />} {working ? "Working…" : primaryLabel}</button></div></article>;
}

export default App;
