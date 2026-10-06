import Link from "next/link";
import type { Metadata } from "next";
import { ArrowRight, CheckCircle2, CircleDot, Hand, Layers, ShieldCheck, Sparkles, SquareDashedMousePointer } from "lucide-react";
import { Logo, Wordmark } from "@/components/logo";

export const metadata: Metadata = {
  title: "Testloop — AI QA that shows its evidence",
  description: "Point Testloop at a URL. It crawls the application, writes the test cases, runs them in a real browser, and marks the bug on the screenshot.",
};

/**
 * The public face of the product.
 *
 * A server component with no client state: it is the page most likely to be seen on a slow
 * connection, and nothing on it needs JavaScript to be readable. Every claim here corresponds to a
 * capability that actually ships — the "how to use" section is written from the real route flow, so
 * it cannot drift into describing a product we do not have.
 */

const steps = [
  {
    n: "01",
    title: "Create a project",
    body: "Give it a name and the URL you want tested. You confirm you own the application or are authorised to test it — Testloop sends real traffic and will submit forms, so this is asked before anything runs.",
    detail: "Projects → New project",
  },
  {
    n: "02",
    title: "Let it crawl",
    body: "Discovery maps the pages, links, forms and interactive elements, and records the API calls the application makes to itself. It stays on your origin and never submits a form.",
    detail: "Test run → Start discovery",
  },
  {
    n: "03",
    title: "Review the test cases",
    body: "The model proposes cases from the crawl. Nothing runs until a person approves it — you can edit the steps first, and an edited case is approved as edited, not as generated.",
    detail: "Test run → Review and approval",
  },
  {
    n: "04",
    title: "Approve the automation",
    body: "Each approved case becomes a versioned step program that is policy-checked before it can execute: no absolute URLs, no embedded credentials, no assertion-free tests.",
    detail: "Test run → Automation",
  },
  {
    n: "05",
    title: "Run it, and answer when asked",
    body: "Execution happens in an isolated browser with video and a trace. If the flow hits an OTP, a CAPTCHA or a payment confirmation, the run pauses and asks you — it never asks for the code itself.",
    detail: "Test run → Execution",
  },
  {
    n: "06",
    title: "Read the evidence",
    body: "Every failure carries its screenshot, video, trace and console log. Draw a box on the screenshot to mark what is wrong; the original file is never modified, so it still matches its checksum.",
    detail: "Bugs → Evidence",
  },
];

const capabilities = [
  {
    icon: Hand,
    title: "It asks instead of failing",
    body: "Most real applications sit behind a login, a one-time code or a payment step. Testloop suspends the run with the browser and session still open, waits for you, and carries on. The code goes into your browser, never into ours.",
  },
  {
    icon: ShieldCheck,
    title: "Accessibility, performance and security",
    body: "Deterministic sweeps over every discovered page. Findings cite a published rule id or a measured value against a budget you set, so a client can check them rather than take your word for it.",
  },
  {
    icon: Layers,
    title: "The same tests, everywhere",
    body: "Replay approved automation across Chromium, Firefox and WebKit at desktop, tablet and mobile — then see whether a difference tracks the browser or the screen size.",
  },
  {
    icon: SquareDashedMousePointer,
    title: "Bugs marked on the picture",
    body: "A red box around the field that broke, with a label. Annotations are stored as regions, never painted in, so the evidence stays verifiable and a box can be relabelled later.",
  },
];

const honest = [
  "Runs on a local model through Ollama. No API key, and nothing leaves your machine.",
  "Only GET, HEAD and OPTIONS are ever replayed against your API — a POST seen during a crawl is listed, never repeated.",
  "Security checks are observation only: headers, cookies, transport. No injection, no bypass attempts, no fuzzing.",
  "Load and stress testing stay locked until you prove you control the domain.",
];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-white">
      {/* ------------------------------------------------------------------ header */}
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-5">
          <Link href="/" aria-label="Testloop home">
            <Wordmark />
          </Link>
          <nav className="ml-auto hidden items-center gap-6 text-sm font-medium text-slate-600 md:flex">
            <a href="#how" className="hover:text-slate-900">How it works</a>
            <a href="#capabilities" className="hover:text-slate-900">Capabilities</a>
            <a href="#limits" className="hover:text-slate-900">What it will not do</a>
          </nav>
          <div className="ml-auto flex items-center gap-2 md:ml-0">
            <Link href="/login" className="rounded-lg px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100">
              Sign in
            </Link>
            <Link href="/signup" className="rounded-lg bg-[#111c38] px-4 py-2 text-sm font-semibold text-white hover:bg-[#1b2a52]">
              Start testing
            </Link>
          </div>
        </div>
      </header>

      {/* ------------------------------------------------------------------ hero */}
      <section className="border-b border-slate-200 bg-[#111c38]">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 py-16 lg:grid-cols-[1.05fr_1fr] lg:py-20">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full bg-violet-500/15 px-3 py-1 text-xs font-semibold text-violet-200 ring-1 ring-inset ring-violet-400/30">
              <CircleDot size={13} />
              Runs on a local model · no API key
            </span>
            <h1 className="mt-5 font-display text-4xl font-bold leading-[1.08] tracking-tight text-white sm:text-5xl">
              Point it at a URL.
              <br />
              Get a QA report with
              <br />
              the evidence attached.
            </h1>
            <p className="mt-5 max-w-lg text-[15px] leading-relaxed text-slate-300">
              Testloop crawls your application, writes the test cases, runs them in a real browser and marks the bug on the screenshot. When it reaches
              something only a person can do, it pauses and asks instead of reporting a failure.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/signup" className="inline-flex items-center gap-2 rounded-lg bg-violet-500 px-5 py-3 text-sm font-bold text-white hover:bg-violet-400">
                Start testing
                <ArrowRight size={16} />
              </Link>
              <a href="#how" className="inline-flex items-center gap-2 rounded-lg border border-white/25 px-5 py-3 text-sm font-bold text-white hover:bg-white/5">
                See how it works
              </a>
            </div>
            <p className="mt-5 text-xs text-slate-400">Only test applications you own or are authorised to test.</p>
          </div>

          {/* A real artifact rather than an abstract illustration: the annotated screenshot is the
              product's most distinctive output, so it is what the hero shows. */}
          <figure className="overflow-hidden rounded-xl border border-white/15 bg-white shadow-2xl">
            <div className="flex h-7 items-center gap-1.5 border-b border-slate-200 bg-slate-100 px-3">
              <span className="h-2 w-2 rounded-full bg-slate-300" />
              <span className="h-2 w-2 rounded-full bg-slate-300" />
              <span className="h-2 w-2 rounded-full bg-slate-300" />
              <span className="ml-2 h-3 flex-1 rounded border border-slate-200 bg-white" />
            </div>
            <div className="relative p-5">
              <div className="h-3 w-28 rounded bg-slate-200" />
              <div className="mt-4 max-w-[19rem] space-y-3">
                <div>
                  <div className="h-2 w-14 rounded bg-slate-200" />
                  <div className="mt-1.5 flex h-8 items-center rounded-md border border-slate-300 px-2.5 text-xs text-slate-500">Ada Lovelace</div>
                </div>
                <div>
                  <div className="h-2 w-10 rounded bg-slate-200" />
                  <div className="mt-1.5 flex h-8 items-center rounded-md border-2 border-rose-500 px-2.5 text-xs text-slate-700 ring-2 ring-rose-100">user@example</div>
                </div>
                <div>
                  <div className="h-2 w-16 rounded bg-slate-200" />
                  <div className="mt-1.5 flex h-8 items-center rounded-md border border-slate-300 px-2.5 text-xs text-slate-400">••••••••</div>
                </div>
                <div className="h-8 w-24 rounded-md bg-[#111c38]" />
              </div>
              <span className="absolute left-[1.15rem] top-[6.4rem] rounded bg-rose-600 px-1.5 py-0.5 font-mono text-[10px] font-bold text-white">
                BUG-004 · accepted without a domain
              </span>
            </div>
          </figure>
        </div>
      </section>

      {/* ------------------------------------------------------------------ how to use */}
      <section id="how" className="border-b border-slate-200">
        <div className="mx-auto max-w-6xl px-5 py-16">
          <p className="text-xs font-bold uppercase tracking-[.16em] text-violet-600">How to use it</p>
          <h2 className="mt-3 max-w-2xl font-display text-3xl font-bold tracking-tight text-slate-900">Six steps, and a person decides at three of them</h2>
          <p className="mt-3 max-w-2xl text-[15px] text-slate-600">
            Each stage unlocks only when the one before it has genuinely finished, so nothing reports a result the stage before it never produced.
          </p>

          <ol className="mt-10 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
            {steps.map(step => (
              <li key={step.n} className="rounded-xl border border-slate-200 p-5">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs font-bold text-violet-600">{step.n}</span>
                  <span className="h-px flex-1 bg-slate-200" />
                </div>
                <h3 className="mt-3 font-display text-lg font-bold text-slate-900">{step.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">{step.body}</p>
                <p className="mt-3 font-mono text-[11px] text-slate-400">{step.detail}</p>
              </li>
            ))}
          </ol>

          <div className="mt-8 flex flex-wrap items-center gap-4 rounded-xl border border-violet-200 bg-violet-50 p-5">
            <Logo size={32} />
            <p className="min-w-0 flex-1 text-sm text-violet-900">
              <strong className="font-display font-bold">You never hand over a one-time code.</strong> When a run pauses for an OTP, a CAPTCHA or a payment
              confirmation, you complete it in your own browser and tell Testloop you are done. There is no field anywhere in the product that could store it.
            </p>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------------ capabilities */}
      <section id="capabilities" className="border-b border-slate-200 bg-slate-50">
        <div className="mx-auto max-w-6xl px-5 py-16">
          <p className="text-xs font-bold uppercase tracking-[.16em] text-violet-600">Capabilities</p>
          <h2 className="mt-3 font-display text-3xl font-bold tracking-tight text-slate-900">Twenty-eight testing types, four engines</h2>
          <p className="mt-3 max-w-2xl text-[15px] text-slate-600">
            Functional, regression, end-to-end, accessibility, performance, security, cross-browser, responsive and API — all producing one evidence model, so
            one report covers them.
          </p>
          <div className="mt-10 grid gap-5 sm:grid-cols-2">
            {capabilities.map(item => (
              <div key={item.title} className="rounded-xl border border-slate-200 bg-white p-6">
                <span className="grid h-10 w-10 place-items-center rounded-lg bg-violet-50 text-violet-700">
                  <item.icon size={19} />
                </span>
                <h3 className="mt-4 font-display text-lg font-bold text-slate-900">{item.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------------ limits */}
      <section id="limits" className="border-b border-slate-200">
        <div className="mx-auto max-w-6xl px-5 py-16">
          <p className="text-xs font-bold uppercase tracking-[.16em] text-violet-600">What it will not do</p>
          <h2 className="mt-3 max-w-2xl font-display text-3xl font-bold tracking-tight text-slate-900">A QA tool that overstates itself is worse than none</h2>
          <ul className="mt-8 grid gap-3 sm:grid-cols-2">
            {honest.map(line => (
              <li key={line} className="flex gap-3 rounded-xl border border-slate-200 p-4">
                <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-emerald-600" />
                <span className="text-sm leading-relaxed text-slate-700">{line}</span>
              </li>
            ))}
          </ul>
          <p className="mt-6 max-w-3xl text-sm text-slate-500">
            Green means a real browser asserted it. A generated test case that has never run is a draft, not a result, and a metric with nothing to compare
            against says so rather than showing a zero.
          </p>
        </div>
      </section>

      {/* ------------------------------------------------------------------ cta */}
      <section className="bg-[#111c38]">
        <div className="mx-auto flex max-w-6xl flex-col items-start gap-6 px-5 py-14 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-2xl font-bold text-white">Test the thing you actually shipped</h2>
            <p className="mt-2 text-sm text-slate-300">Create a project, paste a URL, and watch the crawl come back with something to review.</p>
          </div>
          <div className="flex gap-3">
            <Link href="/signup" className="inline-flex items-center gap-2 rounded-lg bg-violet-500 px-5 py-3 text-sm font-bold text-white hover:bg-violet-400">
              Start testing
              <Sparkles size={15} />
            </Link>
            <Link href="/login" className="inline-flex items-center rounded-lg border border-white/25 px-5 py-3 text-sm font-bold text-white hover:bg-white/5">
              Sign in
            </Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-slate-200">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-5 py-8 text-sm text-slate-500">
          <Wordmark size={22} />
          <p className="ml-auto">Only test applications you own or are authorised to test.</p>
        </div>
      </footer>
    </div>
  );
}
