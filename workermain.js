"use strict";
let hasInitialised = false;
let runtime = null;
function HandleInitRuntimeMessage(e) {
  const data = e.data;
  if (data && data["type"] === "init-runtime") {
    InitRuntime(data);
    self.removeEventListener("message", HandleInitRuntimeMessage);
  }
}
self.addEventListener("message", HandleInitRuntimeMessage);
self.c3_import = (url) => import(url);
function IsAbsoluteURL(url) {
  return (
    /^(?:[a-z\-]+:)?\/\//.test(url) ||
    url.substr(0, 5) === "data:" ||
    url.substr(0, 5) === "blob:"
  );
}
function IsRelativeURL(url) {
  return !IsAbsoluteURL(url);
}
async function LoadScripts(scriptsArr) {
  if (scriptsArr.length === 1) {
    const url = scriptsArr[0];
    await import((IsRelativeURL(url) ? "./" : "") + url);
  } else {
    const scriptStr = scriptsArr
      .map((url) => `import "${IsRelativeURL(url) ? "./" : ""}${url}";`)
      .join("\n");
    const blobUrl = URL.createObjectURL(
      new Blob([scriptStr], { type: "application/javascript" })
    );
    try {
      await import(blobUrl);
    } catch (err) {
      console.warn(
        "[Construct] Unable to import script from blob: URL. Falling back to loading scripts sequentially, which could significantly increase loading time. Make sure blob: URLs are allowed for best performance.",
        err
      );
      for (const url of scriptsArr)
        await import((IsRelativeURL(url) ? "./" : "") + url);
    }
  }
}
async function InitRuntime(data) {
  if (hasInitialised) throw new Error("already initialised");
  hasInitialised = true;
  const messagePort = data["messagePort"];
  const runtimeBaseUrl = data["runtimeBaseUrl"];
  const exportType = data["exportType"];
  self.devicePixelRatio = data["devicePixelRatio"];
  const workerDependencyScripts = data["workerDependencyScripts"].map(
    (urlOrBlob) => {
      let url = urlOrBlob;
      if (urlOrBlob instanceof Blob) url = URL.createObjectURL(urlOrBlob);
      else url = new URL(url, runtimeBaseUrl).toString();
      return url;
    }
  );
  const runOnStartupFunctions = [];
  self.runOnStartup = function runOnStartup(f) {
    if (typeof f !== "function")
      throw new Error("runOnStartup called without a function");
    runOnStartupFunctions.push(f);
  };
  const engineScripts = data["engineScripts"].map((url) =>
    new URL(url, runtimeBaseUrl).toString()
  );
  try {
    await LoadScripts([...workerDependencyScripts, ...engineScripts]);
  } catch (err) {
    console.error(
      "[C3 runtime] Failed to load all engine scripts in worker: ",
      err
    );
    return;
  }
  const scriptsStatus = data["projectScriptsStatus"];
  self["C3_ProjectScriptsStatus"] = scriptsStatus;
  const mainProjectScript = data["mainProjectScript"];
  const allProjectScripts = data["projectScripts"];
  for (let [originalUrl, loadUrl] of allProjectScripts) {
    if (!loadUrl) loadUrl = originalUrl;
    if (originalUrl === mainProjectScript)
      try {
        await LoadScripts([loadUrl]);
        if (exportType === "preview" && !scriptsStatus[originalUrl])
          ReportProjectMainScriptError(
            originalUrl,
            "main script did not run to completion",
            messagePort
          );
      } catch (err) {
        ReportProjectMainScriptError(originalUrl, err, messagePort);
      }
    else if (
      originalUrl === "scriptsInEvents.js" ||
      originalUrl.endsWith("/scriptsInEvents.js")
    )
      await LoadScripts([loadUrl]);
  }
  data["runOnStartupFunctions"] = runOnStartupFunctions;
  if (exportType === "preview" && typeof self.C3.ScriptsInEvents !== "object") {
    const msg =
      "Failed to load JavaScript code used in events. Check all your JavaScript code has valid syntax.";
    console.error("[C3 runtime] " + msg);
    messagePort.postMessage({ type: "alert-error", message: msg });
    return;
  }
  messagePort.postMessage({ type: "creating-runtime" });
  runtime = self["C3_CreateRuntime"](data);
  await self["C3_InitRuntime"](runtime, data);
}
function ReportProjectMainScriptError(url, err, messagePort) {
  console.error(`[Preview] Failed to load project main script (${url}): `, err);
  const msg = `Failed to load project main script (${url}). Check all your JavaScript code has valid syntax. Press F12 and check the console for error details.`;
  messagePort.postMessage({ type: "alert-error", message: msg });
}