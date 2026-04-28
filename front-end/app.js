(function () {
  const cfg = window.PHOTO_APP_CONFIG || {};
  const apigClient = apigClientFactory.newClient({ apiKey: cfg.API_KEY || "" });

  const searchForm = document.getElementById("search-form");
  const searchInput = document.getElementById("search-input");
  const searchStatus = document.getElementById("search-status");
  const results = document.getElementById("results");

  const uploadForm = document.getElementById("upload-form");
  const uploadFile = document.getElementById("upload-file");
  const uploadLabels = document.getElementById("upload-labels");
  const uploadStatus = document.getElementById("upload-status");

  function setStatus(el, text, kind) {
    el.textContent = text;
    el.className = "status" + (kind ? " " + kind : "");
  }

  function renderResults(photos) {
    results.innerHTML = "";
    if (!photos.length) {
      setStatus(searchStatus, "No photos matched your query.", "");
      return;
    }
    setStatus(searchStatus, `Found ${photos.length} photo${photos.length === 1 ? "" : "s"}.`, "ok");
    for (const p of photos) {
      const card = document.createElement("div");
      card.className = "photo";

      const img = document.createElement("img");
      img.src = p.url;
      img.alt = (p.labels || []).join(", ");
      img.loading = "lazy";
      card.appendChild(img);

      const labels = document.createElement("div");
      labels.className = "labels";
      for (const l of p.labels || []) {
        const chip = document.createElement("span");
        chip.className = "label-chip";
        chip.textContent = l;
        labels.appendChild(chip);
      }
      card.appendChild(labels);

      results.appendChild(card);
    }
  }

  searchForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = searchInput.value.trim();
    if (!q) {
      setStatus(searchStatus, "Type a search query first.", "error");
      return;
    }
    setStatus(searchStatus, "Searching…", "");
    results.innerHTML = "";
    try {
      const resp = await apigClient.searchGet({ q }, {});
      const photos = (resp.data && resp.data.results) || [];
      renderResults(photos);
    } catch (err) {
      const msg = err.response ? `Search failed (${err.response.status}): ${JSON.stringify(err.response.data)}` : err.message;
      setStatus(searchStatus, msg, "error");
    }
  });

  uploadForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const file = uploadFile.files[0];
    if (!file) {
      setStatus(uploadStatus, "Select a photo first.", "error");
      return;
    }

    const customLabels = uploadLabels.value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .join(", ");

    const headers = {
      "Content-Type": file.type || "image/jpeg",
      "x-api-key": cfg.API_KEY || "",
    };
    if (customLabels) headers["x-amz-meta-customLabels"] = customLabels;

    setStatus(uploadStatus, "Uploading…", "");
    try {
      // Use fetch instead of the SDK for binary uploads — the SDK's
      // utils.copy() drops ArrayBuffer contents and sends 0 bytes.
      const url = `${cfg.API_BASE_URL.replace(/\/$/, "")}/photos?key=${encodeURIComponent(file.name)}`;
      const resp = await fetch(url, { method: "PUT", headers, body: file });
      if (!resp.ok) throw new Error(`Upload failed (${resp.status}): ${await resp.text()}`);
      setStatus(uploadStatus, `Uploaded "${file.name}".`, "ok");
      uploadForm.reset();
    } catch (err) {
      setStatus(uploadStatus, err.message, "error");
    }
  });
})();
