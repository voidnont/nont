const BRAND_ICON_FALLBACK = "/brand/nonthub.png";

const GENERIC_APP_ICON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PHJlY3QgeD0iNSIgeT0iNSIgd2lkdGg9IjU0IiBoZWlnaHQ9IjU0IiByeD0iMTQiIGZpbGw9IiMyNDIyMmMiLz48cGF0aCBkPSJNMjAgMjQuNWwxMi03IDExLjc1IDYuNzV2MTUuNUwzMiA0Ni41bC0xMi03VjI0LjV6IiBmaWxsPSJub25lIiBzdHJva2U9IiNhNmExYWMiIHN0cm9rZS13aWR0aD0iMyIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPjxwYXRoIGQ9Ik0yMC41IDIyTDMyIDI1LjVsNi41LTMuNzVNMzIgMjUuNXYxNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjOTE2OWRlIiBzdHJva2Utd2lkdGg9IjMiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPjwvc3ZnPg==";

function isNontHubBrandSource(source: string) {
  return /\/brand\/nonthub(?:-(?:dark|light)-(?:rounded|circle))?\.png(?:[?#].*)?$/i.test(source);
}

export function installIconFallbacks() {
  const onImageError = (event: Event) => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement)) return;
    if (image.dataset.nonthubFallbackApplied === "1") return;

    const source = image.currentSrc || image.src || image.getAttribute("src") || "";
    image.dataset.nonthubFallbackApplied = "1";

    if (isNontHubBrandSource(source) && !source.endsWith(BRAND_ICON_FALLBACK)) {
      image.src = BRAND_ICON_FALLBACK;
      return;
    }

    image.classList.add("icon-fallback-image");
    image.src = GENERIC_APP_ICON;
  };

  document.addEventListener("error", onImageError, true);
}
