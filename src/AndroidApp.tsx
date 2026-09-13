import { FormEvent, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Download,
  ExternalLink,
  Github,
  Home,
  Library,
  LoaderCircle,
  PackageOpen,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Smartphone,
} from "lucide-react";

type AndroidTab = "home" | "library" | "settings";

type CatalogApp = {
  id: string;
  name: string;
  subtitle: string;
  description: string;
  category: string;
  repository?: string;
  featured?: boolean;
  website?: string;
};

type AndroidRepositoryInfo = {
  repository: string;
  name: string;
  full_name: string;
  description?: string | null;
  html_url: string;
  owner: string;
  latest_release_tag?: string | null;
  latest_version?: string | null;
};

type AndroidAsset = {
  name: string;
  download_url: string;
  version: string;
  tag_name: string;
  prerelease: boolean;
  asset_size: number;
};

type AndroidPlatformInfo = {
  os: string;
  arch: string;
};

type RepoState = {
  info?: AndroidRepositoryInfo;
  assets: AndroidAsset[];
  image?: string;
  loading: boolean;
  error?: string;
};

type AndroidHistoryItem = {
  repository: string;
  name: string;
  version: string;
  openedAt: string;
};

const STORAGE_REPOS = "nonthub.android.repositories";
const STORAGE_HISTORY = "nonthub.android.history";

function parseRepository(value: string): string | null {
  const input = value.trim();
  const short = input.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (short) return `${short[1]}/${short[2]}`;
  try {
    const url = new URL(input);
    if (!["github.com", "www.github.com"].includes(url.hostname.toLowerCase())) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    return `${parts[0]}/${parts[1].replace(/\.git$/i, "")}`;
  } catch {
    return null;
  }
}

function loadStringArray(key: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function loadHistory(): AndroidHistoryItem[] {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_HISTORY) ?? "[]");
    return Array.isArray(value) ? value.slice(0, 20) : [];
  } catch {
    return [];
  }
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function AndroidApp() {
  const [tab, setTab] = useState<AndroidTab>("home");
  const [catalog, setCatalog] = useState<CatalogApp[]>([]);
  const [customRepos, setCustomRepos] = useState<string[]>(() => loadStringArray(STORAGE_REPOS));
  const [repoState, setRepoState] = useState<Record<string, RepoState>>({});
  const [query, setQuery] = useState("");
  const [addValue, setAddValue] = useState("");
  const [addError, setAddError] = useState("");
  const [platform, setPlatform] = useState<AndroidPlatformInfo>({ os: "android", arch: "unknown" });
  const [version, setVersion] = useState("0.4.4");
  const [history, setHistory] = useState<AndroidHistoryItem[]>(loadHistory);

  useEffect(() => {
    document.documentElement.dataset.platform = "android";
    void invoke<AndroidPlatformInfo>("get_android_platform_info").then(setPlatform).catch(() => undefined);
    void invoke<string>("get_nonthub_runtime_version").then(setVersion).catch(() => undefined);
    fetch("/catalog.json")
      .then((response) => response.json())
      .then((data) => setCatalog(Array.isArray(data.apps) ? data.apps : []))
      .catch(() => setCatalog([]));
  }, []);

  const apps = useMemo(() => {
    const catalogRepos = new Set(catalog.map((app) => app.repository?.toLowerCase()).filter(Boolean));
    const custom: CatalogApp[] = customRepos
      .filter((repository) => !catalogRepos.has(repository.toLowerCase()))
      .map((repository) => {
        const info = repoState[repository]?.info;
        return {
          id: `android-${repository.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
          name: info?.name ?? repository.split("/")[1],
          subtitle: `${repository.split("/")[0]} · GitHub`,
          description: info?.description?.trim() || `Android releases from ${repository}.`,
          category: "GitHub",
          repository,
          featured: false,
        };
      });
    return [...catalog.filter((app) => app.repository), ...custom];
  }, [catalog, customRepos, repoState]);

  const repositories = useMemo(
    () => Array.from(new Set(apps.map((app) => app.repository).filter((value): value is string => Boolean(value)))),
    [apps],
  );

  useEffect(() => {
    for (const repository of repositories) {
      if (!repoState[repository]) void refreshRepository(repository);
    }
    // Each repo is synced once automatically. Manual/global refresh forces a fresh GitHub image scan too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repositories.join("|")]);

  async function refreshRepository(repository: string) {
    setRepoState((current) => ({ ...current, [repository]: { ...(current[repository] ?? { assets: [] }), loading: true, error: undefined } }));
    try {
      const [info, assets, image] = await Promise.all([
        invoke<AndroidRepositoryInfo>("android_repository_info", { repository }),
        invoke<AndroidAsset[]>("android_release_assets", { repository }),
        invoke<string | null>("android_repository_image", { repository }).catch(() => null),
      ]);
      setRepoState((current) => ({
        ...current,
        [repository]: {
          info,
          assets,
          image: image ?? current[repository]?.image,
          loading: false,
        },
      }));
    } catch (error) {
      setRepoState((current) => ({
        ...current,
        [repository]: { ...(current[repository] ?? { assets: [] }), loading: false, error: String(error) },
      }));
    }
  }

  function addRepository(event: FormEvent) {
    event.preventDefault();
    const repository = parseRepository(addValue);
    if (!repository) {
      setAddError("Enter a GitHub repository like owner/project.");
      return;
    }
    setAddError("");
    setAddValue("");
    setCustomRepos((current) => {
      const next = [repository, ...current.filter((item) => item.toLowerCase() !== repository.toLowerCase())].slice(0, 50);
      localStorage.setItem(STORAGE_REPOS, JSON.stringify(next));
      return next;
    });
    setTab("library");
    void refreshRepository(repository);
  }

  function removeRepository(repository: string) {
    setCustomRepos((current) => {
      const next = current.filter((item) => item.toLowerCase() !== repository.toLowerCase());
      localStorage.setItem(STORAGE_REPOS, JSON.stringify(next));
      return next;
    });
  }

  async function openUrl(url: string) {
    await invoke("open_external_url", { url });
  }

  async function downloadApk(repository: string, asset: AndroidAsset) {
    const item: AndroidHistoryItem = {
      repository,
      name: asset.name,
      version: asset.version,
      openedAt: new Date().toISOString(),
    };
    setHistory((current) => {
      const next = [item, ...current.filter((entry) => entry.name !== item.name || entry.repository !== item.repository)].slice(0, 20);
      localStorage.setItem(STORAGE_HISTORY, JSON.stringify(next));
      return next;
    });
    await openUrl(asset.download_url);
  }

  const normalizedQuery = query.trim().toLowerCase();
  const filteredApps = apps.filter((app) => !normalizedQuery || [app.name, app.subtitle, app.description, app.category, app.repository].join(" ").toLowerCase().includes(normalizedQuery));
  const visibleApps = tab === "home" ? filteredApps.filter((app) => app.featured) : filteredApps;

  return (
    <div className="android-shell">
      <header className="android-topbar">
        <div className="android-brand">
          <img src="/brand/nonthub.png" alt="NontHub" />
          <div><strong>NontHub</strong><span><Smartphone size={12} /> Android</span></div>
        </div>
        <button className="android-icon-button" onClick={() => repositories.forEach((repository) => void refreshRepository(repository))} aria-label="Refresh releases and GitHub images"><RefreshCw size={18} /></button>
      </header>

      <main className="android-main">
        {tab !== "settings" && (
          <div className="android-search"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search apps and repositories" /></div>
        )}

        {tab === "home" && (
          <>
            <section className="android-hero">
              <span className="android-kicker"><ShieldCheck size={14} /> APK READY</span>
              <h1>Your Void apps.<br /><em>On Android too.</em></h1>
              <p>NontHub syncs app artwork and Android releases directly from each GitHub repository.</p>
              <button onClick={() => setTab("library")}><Library size={17} /> Open library</button>
            </section>
            <div className="android-section-heading"><div><span>FEATURED</span><h2>Android releases</h2></div></div>
            <div className="android-app-list">
              {visibleApps.map((app) => <AndroidAppCard key={app.id} app={app} state={app.repository ? repoState[app.repository] : undefined} onRefresh={() => app.repository && void refreshRepository(app.repository)} onDownload={(asset) => app.repository && void downloadApk(app.repository, asset)} onOpenGithub={() => app.repository && void openUrl(`https://github.com/${app.repository}`)} />)}
              {visibleApps.length === 0 && <AndroidEmpty text="No featured Android repositories match your search." />}
            </div>
            {history.length > 0 && <section className="android-history"><div className="android-section-heading"><div><span>RECENT</span><h2>APK links opened</h2></div></div>{history.slice(0, 3).map((item) => <div className="android-history-row" key={`${item.repository}-${item.name}`}><Download size={16} /><div><strong>{item.name}</strong><span>{item.repository} · v{item.version}</span></div></div>)}</section>}
          </>
        )}

        {tab === "library" && (
          <>
            <form className="android-add-repo" onSubmit={addRepository}>
              <div><Github size={18} /><input value={addValue} onChange={(event) => setAddValue(event.target.value)} placeholder="owner/repo or GitHub URL" /></div>
              <button type="submit"><Plus size={18} /></button>
              {addError && <small>{addError}</small>}
            </form>
            <div className="android-section-heading"><div><span>LIBRARY</span><h2>{filteredApps.length} repositories</h2></div></div>
            <div className="android-app-list">
              {visibleApps.map((app) => <AndroidAppCard key={app.id} app={app} state={app.repository ? repoState[app.repository] : undefined} onRefresh={() => app.repository && void refreshRepository(app.repository)} onDownload={(asset) => app.repository && void downloadApk(app.repository, asset)} onOpenGithub={() => app.repository && void openUrl(`https://github.com/${app.repository}`)} removable={Boolean(app.repository && customRepos.some((repo) => repo.toLowerCase() === app.repository!.toLowerCase()))} onRemove={() => app.repository && removeRepository(app.repository)} />)}
              {visibleApps.length === 0 && <AndroidEmpty text="Add a GitHub repository to start tracking its APK releases." />}
            </div>
          </>
        )}

        {tab === "settings" && (
          <section className="android-settings">
            <div className="android-settings-title"><span>NONTHUB MOBILE</span><h1>Android</h1><p>GitHub repository metadata, releases, and app artwork stay synced across the APK and Windows hub.</p></div>
            <div className="android-setting-card"><Smartphone size={20} /><div><strong>Device target</strong><span>{platform.os} · {platform.arch}</span></div></div>
            <div className="android-setting-card"><Github size={20} /><div><strong>GitHub image sync</strong><span>Refresh rescans each repository for its current app icon, logo, or brand artwork.</span></div></div>
            <div className="android-setting-card"><PackageOpen size={20} /><div><strong>Package type</strong><span>APK releases only</span></div></div>
            <div className="android-setting-card"><ExternalLink size={20} /><div><strong>Installation flow</strong><span>APK links open in Android's browser/download flow so the system package installer stays in control.</span></div></div>
            <div className="android-setting-card"><ShieldCheck size={20} /><div><strong>NontHub version</strong><span>v{version}</span></div></div>
            <button className="android-wide-button" onClick={() => void openUrl("https://www.nont.me")}><ExternalLink size={17} /> Open nont.me</button>
          </section>
        )}
      </main>

      <nav className="android-bottom-nav" aria-label="NontHub Android navigation">
        <button className={tab === "home" ? "active" : ""} onClick={() => setTab("home")}><Home size={19} /><span>Home</span></button>
        <button className={tab === "library" ? "active" : ""} onClick={() => setTab("library")}><Library size={19} /><span>Library</span></button>
        <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}><Settings size={19} /><span>Settings</span></button>
      </nav>
    </div>
  );
}

function AndroidAppCard({ app, state, onRefresh, onDownload, onOpenGithub, removable, onRemove }: {
  app: CatalogApp;
  state?: RepoState;
  onRefresh: () => void;
  onDownload: (asset: AndroidAsset) => void;
  onOpenGithub: () => void;
  removable?: boolean;
  onRemove?: () => void;
}) {
  const asset = state?.assets?.[0];
  const fallbackGlyph = app.category === "Music" ? "♪" : app.category === "Web" ? "◉" : "◆";
  return <article className="android-app-card">
    <div className="android-app-card-head">
      <div className="android-app-glyph">{state?.image ? <img src={state.image} alt="" draggable={false} /> : fallbackGlyph}</div>
      <div className="android-app-title"><span>{app.category}</span><h3>{state?.info?.name ?? app.name}</h3><small>{app.repository}</small></div>
      <button className={`android-refresh ${state?.loading ? "spin" : ""}`} onClick={onRefresh} aria-label={`Refresh ${app.name}`}><RefreshCw size={16} /></button>
    </div>
    <p>{state?.info?.description?.trim() || app.description}</p>
    {state?.error && <div className="android-repo-error">{state.error}</div>}
    <div className="android-release-line">
      {state?.loading ? <><LoaderCircle size={15} className="spin" /> Syncing GitHub…</> : asset ? <><PackageOpen size={15} /> v{asset.version} · {formatBytes(asset.asset_size)}{asset.prerelease ? " · prerelease" : ""}</> : <><PackageOpen size={15} /> No APK release found</>}
    </div>
    <div className="android-card-actions">
      <button className="android-secondary" onClick={onOpenGithub}><Github size={16} /> GitHub</button>
      <button className="android-primary" disabled={!asset || state?.loading} onClick={() => asset && onDownload(asset)}><Download size={16} /> {asset ? "Download APK" : "No APK"}</button>
    </div>
    {removable && onRemove && <button className="android-remove" onClick={onRemove}>Remove from library</button>}
  </article>;
}

function AndroidEmpty({ text }: { text: string }) {
  return <div className="android-empty"><PackageOpen size={28} /><strong>Nothing here yet</strong><span>{text}</span></div>;
}

export default AndroidApp;