"use client";

import { useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Bot, Check, ChevronDown, ClipboardCheck, ImagePlus, Rocket, ShieldCheck, X } from "lucide-react";
import { Shell } from "@/components/shell";
import { ErrorState } from "@/components/states";
import { ApiError, api, applicationTypeOptions, manualTestingTypeOptions, uploadEvidence, type Project, type TestRun, type TestingMethod } from "@/lib/api";
import { useResource } from "@/lib/use-resource";

type ProjectWithEnvironments = Project & { environments?: { id: string; name: string; baseUrl: string }[] };

const methods: { value: TestingMethod; title: string; detail: string; icon: typeof Bot }[] = [
  { value: "AUTOMATED", title: "AI / Automated Testing", detail: "Crawl, generate, automate, and run in a real browser.", icon: Bot },
  { value: "MANUAL", title: "Manual Testing", detail: "Generate test cases, execute them yourself, and record evidence.", icon: ClipboardCheck },
];

const testingTypeGroups: Record<string, string[]> = {
  Functional: ["Functional Testing", "Form Validation", "Navigation", "Authentication", "Search", "Filters", "Pagination", "File Upload", "Error Handling"],
  "UI / Visual": ["UI Testing", "Visual Testing", "Layout", "Broken Images", "Typography", "Component States"],
  Responsive: ["Desktop", "Tablet", "Mobile"],
  "Browser Compatibility": ["Chromium", "Firefox", "WebKit"],
  Accessibility: ["Accessibility", "Keyboard Navigation", "Form Labels", "ARIA"],
  Performance: ["Page Load", "Network", "Performance"],
  API: ["API Discovery", "API Validation"],
  Security: ["Authorized security checks"],
};

const defaultSettings = {
  browser: "chromium",
  viewport: "desktop",
  customViewport: { width: 1440, height: 900 },
  maxPages: 50,
  maxTestCases: 100,
  timeoutSeconds: 30,
  retryCount: 1,
  captureScreenshots: true,
  recordVideo: false,
  captureTrace: true,
  consoleLogging: true,
  networkLogging: true,
  visualThreshold: 0.1,
};

type Settings = typeof defaultSettings;

const numericFields: { key: keyof Pick<Settings, "maxPages" | "maxTestCases" | "timeoutSeconds" | "retryCount">; label: string; min: number; max: number }[] = [
  { key: "maxPages", label: "Max pages to crawl", min: 1, max: 500 },
  { key: "maxTestCases", label: "Max test cases", min: 1, max: 1000 },
  { key: "timeoutSeconds", label: "Step timeout (seconds)", min: 5, max: 300 },
  { key: "retryCount", label: "Retries on failure", min: 0, max: 5 },
];

const toggleFields: { key: keyof Pick<Settings, "captureScreenshots" | "recordVideo" | "captureTrace" | "consoleLogging" | "networkLogging">; label: string }[] = [
  { key: "captureScreenshots", label: "Capture screenshots" },
  { key: "recordVideo", label: "Record video" },
  { key: "captureTrace", label: "Capture Playwright trace" },
  { key: "consoleLogging", label: "Collect console logs" },
  { key: "networkLogging", label: "Collect network log" },
];

export default function NewTestRunPage() {
  const router = useRouter();
  const projects = useResource(() => api.get<ProjectWithEnvironments[]>("/api/v1/projects"), []);

  const [method, setMethod] = useState<TestingMethod>("AUTOMATED");
  const [applicationType, setApplicationType] = useState("");
  const [manualTypes, setManualTypes] = useState<string[]>(["Functional", "Smoke"]);
  const [environmentId, setEnvironmentId] = useState("");
  const [references, setReferences] = useState<File[]>([]);
  const manual = method === "MANUAL";

  const [projectId, setProjectId] = useState("");
  const [url, setUrl] = useState("");
  const [requirements, setRequirements] = useState("");
  const [selected, setSelected] = useState<string[]>(["Functional Testing"]);
  const [authorized, setAuthorized] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // When there is exactly one project it is preselected, derived during render rather than written
  // back into state from an effect - the choice is a function of the loaded data plus any explicit
  // selection, so storing it twice would only create a second source of truth.
  const soleProject = projects.data?.length === 1 ? projects.data[0] : null;
  const effectiveProjectId = projectId || soleProject?.id || "";
  const effectiveUrl = url || soleProject?.applicationUrl || "";

  const normalizedUrl = useMemo(() => {
    try {
      const value = new URL(effectiveUrl.trim());
      if (!["http:", "https:"].includes(value.protocol)) return "";
      value.hash = "";
      return value.toString().replace(/\/$/, "");
    } catch {
      return "";
    }
  }, [effectiveUrl]);

  const toggleType = (value: string) => setSelected(current => (current.includes(value) ? current.filter(item => item !== value) : [...current, value]));
  const toggleManualType = (value: string) => setManualTypes(current => (current.includes(value) ? current.filter(item => item !== value) : [...current, value]));
  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => setSettings(current => ({ ...current, [key]: value }));
  const activeTypes = manual ? manualTypes : selected;
  const selectedProject = projects.data?.find(item => item.id === effectiveProjectId);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!effectiveProjectId) return setError("Select a project before starting the test.");
    if (!normalizedUrl) return setError("Enter a valid HTTP or HTTPS URL.");
    if (manual && !applicationType) return setError("Choose the application type so the test cases fit the application.");
    if (!activeTypes.length) return setError("Select at least one testing type.");
    if (!authorized) return setError("Confirm that you are authorized to test this application.");

    setBusy(true);
    try {
      // customViewport is only meaningful - and only accepted - for the custom viewport option.
      const { customViewport, ...rest } = settings;
      const advancedSettings = settings.viewport === "custom" ? { ...rest, customViewport } : rest;
      const run = await api.post<TestRun>("/api/v1/test-runs", {
        projectId: effectiveProjectId,
        applicationUrl: normalizedUrl,
        requirements,
        testingTypes: activeTypes,
        advancedSettings,
        authorizationConfirmed: true,
        // The automated request is byte-for-byte what it was before manual testing existed.
        ...(manual ? { testingMethod: "MANUAL", applicationType } : {}),
      });
      if (!manual) return router.push(`/test-runs/${run.id}`);
      // Reference material is stored against the new run; a failed upload is reported on arrival
      // rather than silently dropped.
      let failedUploads = 0;
      for (const file of references) {
        try {
          await uploadEvidence(`/api/v1/manual-runs/${run.id}/references`, file, file.name);
        } catch {
          failedUploads += 1;
        }
      }
      router.push(`/test-runs/${run.id}/manual${failedUploads ? `?referenceUploadFailures=${failedUploads}` : ""}`);
    } catch (caught) {
      setError(caught instanceof ApiError ? `${caught.code}: ${caught.message}` : "Unable to create the test run.");
      setBusy(false);
    }
  };

  const field = "mt-2 w-full rounded-lg border border-slate-300 px-3 py-3 text-sm font-normal outline-none focus:border-violet-500";

  return (
    <Shell title="Start a new test" subtitle="Configure the scope. No crawl, AI call, or browser run happens yet.">
      <Link href="/test-runs" className="mb-6 inline-flex items-center gap-2 text-sm font-medium text-slate-600 hover:text-slate-900">
        <ArrowLeft size={16} />
        Test runs
      </Link>

      {projects.error ? (
        <ErrorState error={projects.error} retry={projects.reload} />
      ) : (
        <form onSubmit={submit} className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="space-y-6">
            <section className="rounded-xl border border-slate-200 bg-white p-6">
              <h2 className="font-display text-lg font-bold">Testing method</h2>
              <div className="mt-4 grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Testing method">
                {methods.map(({ value, title, detail, icon: Icon }) => {
                  const active = method === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setMethod(value)}
                      className={`flex items-start gap-3 rounded-xl border p-4 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-violet-500 ${active ? "border-violet-500 bg-violet-50 ring-1 ring-violet-500" : "border-slate-200 hover:border-slate-300"}`}
                    >
                      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${active ? "bg-violet-600 text-white" : "bg-slate-100 text-slate-600"}`}>
                        <Icon size={18} />
                      </span>
                      <span>
                        <b className="block text-sm text-slate-900">{title}</b>
                        <span className="mt-0.5 block text-xs leading-5 text-slate-500">{detail}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="rounded-xl border border-slate-200 bg-white p-6">
              <h2 className="font-display text-lg font-bold">1. Application</h2>

              <label className="mt-5 block text-sm font-semibold">
                Project
                <select
                  value={effectiveProjectId}
                  onChange={event => {
                    setProjectId(event.target.value);
                    const project = projects.data?.find(item => item.id === event.target.value);
                    if (project) setUrl(project.applicationUrl);
                  }}
                  className={field}
                >
                  <option value="">{projects.loading ? "Loading projects…" : "Select a project"}</option>
                  {projects.data?.map(project => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
                {!projects.loading && projects.data?.length === 0 && (
                  <span className="mt-2 block text-xs font-normal text-amber-700">
                    No projects yet.{" "}
                    <Link href="/projects" className="font-bold underline">
                      Create one first
                    </Link>
                    .
                  </span>
                )}
              </label>

              <label className="mt-4 block text-sm font-semibold">
                Application URL
                <input value={effectiveUrl} onChange={event => setUrl(event.target.value)} placeholder="https://example.com" className={field} />
                {effectiveUrl &&
                  (normalizedUrl ? (
                    <span className="mt-2 flex items-center gap-1 text-xs font-normal text-emerald-600">
                      <Check size={14} />
                      Valid target: {new URL(normalizedUrl).hostname}
                    </span>
                  ) : (
                    <span className="mt-2 block text-xs font-normal text-rose-600">Use a valid HTTP or HTTPS URL.</span>
                  ))}
              </label>

              {manual && (
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <label className="block text-sm font-semibold">
                    Application type <span className="text-rose-600">*</span>
                    <select value={applicationType} onChange={event => setApplicationType(event.target.value)} className={field} required>
                      <option value="">Select the application type</option>
                      {applicationTypeOptions.map(option => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-sm font-semibold">
                    Environment <span className="font-normal text-slate-400">(optional)</span>
                    <select
                      value={environmentId}
                      disabled={!selectedProject?.environments?.length}
                      onChange={event => {
                        setEnvironmentId(event.target.value);
                        const environment = selectedProject?.environments?.find(item => item.id === event.target.value);
                        setUrl(environment ? environment.baseUrl : (selectedProject?.applicationUrl ?? ""));
                      }}
                      className={`${field} disabled:bg-slate-50 disabled:text-slate-400`}
                    >
                      <option value="">{selectedProject?.environments?.length ? "Project default URL" : "No environments defined for this project"}</option>
                      {selectedProject?.environments?.map(environment => (
                        <option key={environment.id} value={environment.id}>{environment.name}</option>
                      ))}
                    </select>
                  </label>
                </div>
              )}

              <label className="mt-5 block text-sm font-semibold">
                {manual ? "Requirements or focus areas" : "Tell AI what you want to test"} <span className="font-normal text-slate-400">(optional)</span>
                <textarea
                  value={requirements}
                  maxLength={10000}
                  onChange={event => setRequirements(event.target.value)}
                  placeholder="Example: test login, registration, and checkout. Focus on invalid inputs and error handling."
                  className={`${field} min-h-28`}
                />
                <span className="block text-right text-xs font-normal text-slate-400">{requirements.length.toLocaleString()} / 10,000</span>
                {manual && <span className="block text-xs font-normal text-slate-500">Each requirement on its own line becomes a traceable test case.</span>}
              </label>

              {manual && (
                <div className="mt-4">
                  <p className="text-sm font-semibold">
                    Reference screenshots <span className="font-normal text-slate-400">(optional)</span>
                  </p>
                  <label className="mt-2 flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 px-4 py-4 text-sm text-slate-600 focus-within:ring-2 focus-within:ring-violet-500 hover:border-violet-400 hover:text-violet-700">
                    <ImagePlus size={16} />
                    Add mock-ups or screenshots (PNG, JPEG, WebP)
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      multiple
                      className="sr-only"
                      onChange={event => {
                        const files = Array.from(event.target.files ?? []);
                        setReferences(current => [...current, ...files].slice(0, 10));
                        event.target.value = "";
                      }}
                    />
                  </label>
                  {references.length > 0 && (
                    <ul className="mt-2 flex flex-wrap gap-2">
                      {references.map((file, index) => (
                        <li key={`${file.name}-${index}`} className="flex items-center gap-1.5 rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-700">
                          {file.name}
                          <button type="button" aria-label={`Remove ${file.name}`} onClick={() => setReferences(current => current.filter((_, position) => position !== index))} className="rounded text-slate-400 hover:text-slate-700">
                            <X size={13} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              <label className="mt-4 flex items-start gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
                <input type="checkbox" checked={authorized} onChange={event => setAuthorized(event.target.checked)} className="mt-0.5 h-4 w-4 accent-violet-600" />
                <span>
                  <b>I confirm that I am authorized to test this application.</b>
                  <small className="mt-1 block text-xs text-slate-500">Only authorized checks are supported. Penetration testing is unavailable.</small>
                </span>
              </label>
            </section>

            <section className="rounded-xl border border-slate-200 bg-white p-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="font-display text-lg font-bold">2. Testing types</h2>
                  <p className="mt-1 text-sm text-slate-500">{activeTypes.length} selected</p>
                </div>
                <div className="flex gap-4 text-xs font-bold text-violet-600">
                  <button type="button" onClick={() => (manual ? setManualTypes([...manualTestingTypeOptions]) : setSelected(Object.values(testingTypeGroups).flat()))}>
                    Select all
                  </button>
                  <button type="button" onClick={() => (manual ? setManualTypes([]) : setSelected([]))}>
                    Clear all
                  </button>
                </div>
              </div>

              {manual ? (
                <div className="mt-6 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {manualTestingTypeOptions.map(value => (
                    <label
                      key={value}
                      className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm ${manualTypes.includes(value) ? "border-violet-300 bg-violet-50 text-violet-800" : "border-slate-200 text-slate-600"}`}
                    >
                      <input type="checkbox" checked={manualTypes.includes(value)} onChange={() => toggleManualType(value)} className="h-4 w-4 accent-violet-600" />
                      {value}
                    </label>
                  ))}
                </div>
              ) : (
              <div className="mt-6 space-y-6">
                {Object.entries(testingTypeGroups).map(([group, values]) => (
                  <fieldset key={group}>
                    <legend className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-400">{group}</legend>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {values.map(value => (
                        <label
                          key={value}
                          className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm ${selected.includes(value) ? "border-violet-300 bg-violet-50 text-violet-800" : "border-slate-200 text-slate-600"}`}
                        >
                          <input type="checkbox" checked={selected.includes(value)} onChange={() => toggleType(value)} className="h-4 w-4 accent-violet-600" />
                          {value}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                ))}
              </div>
              )}
            </section>

            <section className="rounded-xl border border-slate-200 bg-white">
              <button type="button" onClick={() => setAdvancedOpen(value => !value)} aria-expanded={advancedOpen} className="flex w-full items-center justify-between p-6 text-left">
                <span>
                  <b className="font-display text-lg">3. {manual ? "Browser and discovery settings" : "Advanced settings"}</b>
                  <small className="mt-1 block text-sm text-slate-500">{manual ? "Browser and viewport for the testing window, and limits for optional discovery" : "Browser, limits, evidence, and timeout controls"}</small>
                </span>
                <ChevronDown className={`transition-transform ${advancedOpen ? "rotate-180" : ""}`} />
              </button>

              {advancedOpen && (
                <div className="grid gap-4 border-t border-slate-100 p-6 sm:grid-cols-2">
                  <label className="text-sm font-semibold">
                    Browser
                    <select value={settings.browser} onChange={event => update("browser", event.target.value)} className={field}>
                      {["chromium", "firefox", "webkit"].map(value => (
                        <option key={value} value={value}>{value}</option>
                      ))}
                    </select>
                  </label>

                  <label className="text-sm font-semibold">
                    Viewport
                    <select value={settings.viewport} onChange={event => update("viewport", event.target.value)} className={field}>
                      {["desktop", "tablet", "mobile", "custom"].map(value => (
                        <option key={value} value={value}>{value}</option>
                      ))}
                    </select>
                  </label>

                  {/* Custom dimensions are required by the API whenever the custom viewport is chosen;
                      without these inputs the form could be filled in but never submitted. */}
                  {settings.viewport === "custom" && (
                    <>
                      <label className="text-sm font-semibold">
                        Viewport width
                        <input
                          type="number"
                          min={320}
                          max={3840}
                          value={settings.customViewport.width}
                          onChange={event => update("customViewport", { ...settings.customViewport, width: Number(event.target.value) })}
                          className={field}
                        />
                      </label>
                      <label className="text-sm font-semibold">
                        Viewport height
                        <input
                          type="number"
                          min={240}
                          max={2160}
                          value={settings.customViewport.height}
                          onChange={event => update("customViewport", { ...settings.customViewport, height: Number(event.target.value) })}
                          className={field}
                        />
                      </label>
                    </>
                  )}

                  {numericFields.map(({ key, label, min, max }) => (
                    <label key={key} className="text-sm font-semibold">
                      {label}
                      <input type="number" min={min} max={max} value={settings[key]} onChange={event => update(key, Number(event.target.value))} className={field} />
                    </label>
                  ))}

                  <label className="text-sm font-semibold sm:col-span-2">
                    Visual diff threshold ({settings.visualThreshold})
                    <input type="range" min={0} max={1} step={0.01} value={settings.visualThreshold} onChange={event => update("visualThreshold", Number(event.target.value))} className="mt-2 w-full accent-violet-600" />
                  </label>

                  <div className="grid gap-2 sm:col-span-2 sm:grid-cols-2">
                    {toggleFields.map(({ key, label }) => (
                      <label key={key} className="flex items-center gap-3 text-sm">
                        <input type="checkbox" checked={settings[key]} onChange={event => update(key, event.target.checked)} className="h-4 w-4 accent-violet-600" />
                        {label}
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </section>
          </div>

          <aside className="h-fit rounded-xl border border-slate-200 bg-white p-6 lg:sticky lg:top-6">
            <div className="flex items-center gap-2">
              <ShieldCheck className="text-violet-600" size={19} />
              <h2 className="font-display font-bold">Review configuration</h2>
            </div>

            <dl className="mt-5 space-y-4 text-sm">
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-400">Method</dt>
                <dd className="mt-1 font-medium">{manual ? "Manual testing" : "AI / Automated testing"}</dd>
              </div>
              {manual && (
                <div>
                  <dt className="text-xs uppercase tracking-wide text-slate-400">Application type</dt>
                  <dd className="mt-1 font-medium">{applicationTypeOptions.find(option => option.value === applicationType)?.label ?? "Not selected"}</dd>
                </div>
              )}
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-400">Project</dt>
                <dd className="mt-1 font-medium">{projects.data?.find(item => item.id === effectiveProjectId)?.name ?? "Not selected"}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-400">Application</dt>
                <dd className="mt-1 break-all font-medium">{normalizedUrl || "Not provided"}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-400">Requirements</dt>
                <dd className="mt-1 font-medium">{requirements ? "Custom requirements provided" : "No custom requirements"}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-400">Testing types</dt>
                <dd className="mt-1 font-medium">{activeTypes.length ? `${activeTypes.length} selected` : "None selected"}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-400">Browser</dt>
                <dd className="mt-1 font-medium capitalize">
                  {settings.browser} · {settings.viewport}
                  {settings.viewport === "custom" ? ` ${settings.customViewport.width}×${settings.customViewport.height}` : ""}
                </dd>
              </div>
            </dl>

            {error && <p className="mt-5 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">{error}</p>}

            <button
              type="submit"
              disabled={busy || !authorized || !normalizedUrl || !activeTypes.length || !effectiveProjectId || (manual && !applicationType)}
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-[#111c38] px-4 py-3 text-sm font-bold text-white disabled:opacity-40"
            >
              {manual ? <ClipboardCheck size={15} /> : <Rocket size={15} />}
              {busy ? "Creating test run…" : manual ? "Start manual testing" : "Start AI testing"}
            </button>
            <p className="mt-3 text-center text-[11px] leading-5 text-slate-400">
              {manual ? "Creates the run. You generate test cases and open the testing window in the next step." : "Creates a queued configuration only. No request is made to the target yet."}
            </p>
          </aside>
        </form>
      )}
    </Shell>
  );
}
