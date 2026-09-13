export type AppKind = "github-release" | "direct" | "builtin";
export type BuiltinRoute = "downloads";

export type NontHubApp = {
  id: string;
  name: string;
  subtitle: string;
  description: string;
  category: string;
  kind: AppKind;
  repository?: string;
  assetExtensions?: string[];
  downloadUrl?: string;
  builtinRoute?: BuiltinRoute;
  featured?: boolean;
  icon?: string;
  version?: string;
  website?: string;
  synced?: boolean;
};

export type GithubRepositoryInfo = {
  repository: string;
  name: string;
  full_name: string;
  description?: string | null;
  html_url: string;
  owner: string;
  default_branch: string;
  topics: string[];
  latest_release_tag?: string | null;
  latest_release_name?: string | null;
  latest_version?: string | null;
};

export type SyncedRepository = {
  repository: string;
  app_id: string;
  name: string;
  subtitle: string;
  description: string;
  category: string;
  html_url?: string;
  latest_version?: string | null;
  latest_release_tag?: string | null;
  synced_at?: string;
};

export type DownloadStatus = "queued" | "downloading" | "paused" | "complete" | "failed" | "cancelled";

export type DownloadItem = {
  id: string;
  name: string;
  url: string;
  status: DownloadStatus;
  progress: number;
  receivedBytes: number;
  totalBytes?: number;
  path?: string;
  error?: string;
  appId?: string;
  repository?: string;
  packageType?: string;
  expectedDigest?: string;
  queueOrder?: number;
  createdAt?: number;
  startedAt?: number;
  completedAt?: number;
  speedBps?: number;
  etaSeconds?: number;
};

export type DownloadProgressPayload = {
  id: string;
  received_bytes: number;
  total_bytes?: number | null;
  percent?: number | null;
  status: DownloadStatus;
  path?: string | null;
  error?: string | null;
};

export type ResolvedAsset = {
  name: string;
  download_url: string;
  version: string;
  tag_name: string;
  release_name?: string | null;
  prerelease: boolean;
  package_type: string;
  asset_id: number;
  asset_size: number;
  asset_updated_at?: string | null;
  asset_digest?: string | null;
};

export type InstalledAppInfo = {
  app_id: string;
  installed: boolean;
  version?: string | null;
  executable_path?: string | null;
  asset_name?: string | null;
  package_type?: string | null;
  repository?: string | null;
  release_tag?: string | null;
  asset_id?: number | null;
  asset_digest?: string | null;
  asset_updated_at?: string | null;
};

export type ThemeMode = "system" | "dark" | "bright";
export type BrandIconShape = "rounded" | "circle";
export type CloseBehavior = "ask" | "minimize" | "exit";

export type PlatformInfo = {
  os: "windows";
  arch: string;
  download_location: string;
};

export type GithubPackageTarget = "auto" | "exe" | "msi";

export type NontHubUserProfile = {
  schema_version: number;
  onboarding_complete: boolean;
  theme: ThemeMode;
  brand_icon_shape?: BrandIconShape;
  downloads: DownloadItem[];
  close_behavior: CloseBehavior;
  synced_repositories?: SyncedRepository[];
  concurrent_downloads?: number;
  auto_check_updates?: boolean;
};
