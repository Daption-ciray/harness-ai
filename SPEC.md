# harness-ai — Tasarım Spesifikasyonu

**Durum:** taslak v1 · **Tarih:** 2026-08-27

Herhangi bir git deposuna takılabilen, çok-ajanlı, sürekli çalışan bir geliştirme
harness'ı. Roller kendi işini yapar, birbirini denetler, ürünü kademeli geliştirir.
İnsan sadece kritik noktalarda devreye girer.

---

## 1. Kapsam

**Hedef:** `npx harness init` ile herhangi bir repoya kurulan, arka planda çalışan
bir daemon. Backlog'dan iş alır, kod yazar, kendi kendini denetler, PR açar,
kritik olmayanları otomatik merge eder.

**MVP dışı:** container sandbox, çoklu provider, çok-kullanıcılı web UI,
GitHub dışı forge desteği.

---

## 2. Temel kararlar

| Konu | Karar |
|---|---|
| Substrat | `@anthropic-ai/claude-agent-sdk`, TypeScript, tek provider |
| Orkestrasyon | Sabit orchestrator yok — policy routing + TTL'li lease |
| Öldürme | Yok. Preempt = merge kapısı kapanır + quarantine |
| Onay | Otomatik merge varsayılan, `escalate_when` ile insana çıkar |
| Forge | GitHub zorunlu (`gh` CLI). Remote yoksa harness başlamaz |
| Hafıza | `decisions.md` repoda, gürültü sidecar'da |
| Kalıcılık | Yeniden üretilebilen sidecar'a, yeri doldurulamaz repoya |
| Karar maliyeti | Tier/sınıflandırma deterministik — model çağrısı yok |

---

## 3. Roller

Bir rol ancak şu üçünden birine sahipse var olur:
1. Kendi veto domain'i, 2. Uyumsuz teşviki, 3. Herkesin okuduğu bir artefaktın tek sahipliği.

| Rol | Veto | Ölçek | Yazma yetkisi | Var olma gerekçesi |
|---|---|---|---|---|
| `planner` | — | 1 | backlog, task | DAG sahibi, default lease |
| `builder` | — | ×N worktree | kod | Tek ölçeklenen düğüm |
| `adversary` | soft | 1–2 | test | Teşvik çatışması: kırmaya çalışır. Worktree'de koşar — başarısız test yazmak en güçlü bulgudur |
| `review` | soft (2 tur) | 1 | — | Kalite/tasarım domain'i. Araçsız; eline verilen diff'i okur |
| `security` | **hard** | 1 | — | Tek gerçek hard veto |
| `devops` | soft (CI) | **1, tekil** | git, gh, CI | git/CI'ın tek yazarı |
| `scribe` | — | 1 | `decisions.md`, `context.md`, PR body | Hafızanın tek yazarı |

### Kesilen roller
`integrator` → `devops`'a katıldı · `docs` → review kontrol maddesi ·
`perf` → review lensi · `product` → insan · `scout` → planner'ın soğuk başlangıç görevi

### `builder` kendi unit testini yazar
Ayrı "test yazan takım" yok. `adversary` test yazmaz — **kırmaya** çalışır:
edge case, fuzz, regression, "bu iddiayı çürüt".

### `devops` = kalın script üstünde ince ajan
**Script yapar:** branch, commit, push, PR aç, worktree kur/yık, label, draft toggle, rebase dene.
**Ajan karar verir:** CI kırmızısı gerçek mi flaky mi, rebase çakışması nasıl çözülür,
PR merge'e hazır mı.
Yeşil CI + temiz rebase = ajan hiç uyanmaz.

### Tek yazar deseni
- `scribe` → hafızanın tek yazarı
- `devops` → git/CI'ın tek yazarı

`git` ve `gh`, `devops` dışındaki tüm rollerde deny listesinde. `index.lock` yarışı
yapısal olarak imkânsız: tek kuyruk tüketicisi.

---

## 4. Graf

Ağaç değil graf — `veto` ve `preempt` kenarları hiyerarşiyi kırar.

**Kenar tipleri:** `dispatch` (iş ver) · `report` (sonuç dön) · `veto` (blokla) ·
`preempt` (liderliği al) · `escalate` (insana çık) · `flag` (görünürlük, yetki değil)

`scribe` bir **sink node**: sadece `report` in-edge alır, tek out-edge tipi `flag`.
Hiçbir şeyi bloklamaz → kritik yolun dışında, async koşar.

---

## 5. Lease ve preempt

Her olay `(domain, severity)` etiketli. `policy.yaml` routing tablosu lease sahibini
belirler. Lease = TTL'li, iptal edilebilir.

- `preempt: true` olan rol (yalnız `security`) sıradaki lease'i keser, DAG'ı yeniden yazar.
- Preempt **süreç öldürmez**: çalışan builder işini bitirir, çıktısı worktree'de kalır,
  merge kapısı kapanır (PR draft + `blocked:security`).
- Lease bitince default sahibine (`planner`) döner.

Deterministik kalır — tam P2P mesaj borsasına göre debug edilebilir.

---

## 6. Durum makinesi

```
queued ─(planner)→ planned ─(builder)→ verifying ─(hepsi geçti)→ integrating ─(devops)→ escalated
                      ↑                     │                                              │
                      └──── soft veto ──────┤                                          insan merge
                                            └── hard veto → quarantined → insan
```

**Revision.** Her `build_done` revision'ı bir artırır. Verdict'ler her zaman *bir*
revision hakkındadır; soft veto revision'ı kapatır, yeni build yeni revision üretir
ve tüm doğrulayıcılar baştan karar verir.

**Gate ≠ lease.** Hangi doğrulayıcıların rapor vermesi gerektiği (`verify.ts`) ile
sıranın kime ait olduğu (`lease.ts`) ayrı sorulardır. Bu ayrım sayesinde lease'in
TTL ile geri alınması hiçbir zorunlu doğrulayıcıyı atlayamaz.

**Bulgular yapısaldır.** Doğrulayıcı düzyazı değil `{file, line?, severity, summary}`
döner. Yalnız `blocker` veto sayılır; `concern` PR gövdesine gider. Durma
dedektörleri bu yapı üstünde mekanik çalışır — iki şikâyetin "aynı" olup olmadığına
model karar vermez.

### Durma koşulları
- Task başına round + USD bütçesi
Üç dedektör, hepsi `blocker` bulgu anahtarları üstünde deterministik:

- **`max_rounds`** — rol veto hakkını tüketti (`review` 2, `adversary` 3)
- **`no_progress`** — ardışık iki revision'da aynı blocker kümesi. Builder bir şey
  değiştirdi, şikâyet değişmedi; bir tur daha fayda etmez. Anahtar kasten kaba:
  şikâyeti yeniden ifade etmek yeni bilgi sayılmaz.
- **`ping_pong`** — temizlenen bir blocker geri geldi; iki taraf birbirini geri alıyor

Kontrol **her aşamadan önce** koşar, sadece doğrulamadan önce değil: veto görevi
builder'a geri gönderir, ve doğrulama adımına konmuş bir kontrol bunu fark etmeden
önce bir build daha ödetir.

---

## 7. Kabul kriteri sözleşmesi

`planner` her göreve makine-okunur kriter yazmak **zorunda**. Yazamıyorsa görev
yeterince tanımlı değil → insana sor.

```yaml
task: bk-142
origin: trusted                 # trusted | untrusted
class: risky                    # trivial | routine | risky
acceptance:
  - "test: npm test -- auth.spec.ts geçer"
  - "davranış: süresi geçmiş token 401 döner, 500 değil"
  - "kapsam: sadece src/auth/**"
```

`adversary` bunlara karşı test eder. `kapsam` satırı scope creep'i mekanik durdurur:
kapsam dışı diff'i `review` otomatik reddeder, LLM turu harcamadan.

---

## 8. Merge ve escalation

```yaml
merge:
  auto: true
  escalate_when:
    - first_n_merges: 20        # otonomi kazanılır, hediye edilmez
    - origin: untrusted         # istisnasız
    - task_class: risky
    - security_finding: any
    - review_rounds: ">=2"
    - diff_files: ">15"
    - public_api_change: true
    - acceptance_unmet: any
  max_pending_escalated: 3      # dolunca loop yeni iş başlatmaz
```

Sınıflandırma deterministik: dosya glob'u, diff büyüklüğü, backlog kaynağı, deneme sayısı.
Model'e sorulmaz.

**Geri alma:** `harness revert <trace_id>` — otomatik merge edilen her şey tek komutla.
**Günlük özet:** gece ne merge edildi, ne harcandı.

> **Not:** branch protection "1 review zorunlu" ise harness merge edemez.
> Harness token'ının bypass yetkisi bilinçli kurulmalı.

---

## 9. Güvenlik modeli

Ajanlar kullanıcının makinesinde, kullanıcının kimliğiyle, gözetimsiz `Bash` çalıştırır.
Otomatik merge, prompt injection savunmasındaki son insan kapısını kaldırır.
Bu bölüm tavsiye değil, gereksinim.

### Üç katman, farklı işler

Hiçbiri tek başına yetmez.

**1. OS sandbox — Bash üstündeki tek gerçek zorlama.**
`runtime.sandbox: os` ile Claude Code sandbox'ı (macOS Seatbelt, Linux/WSL2).
Çekirdek düzeyinde, her alt sürece kadar. Regex bir kabuğu güvenli yapamaz:
`echo x > ~/.ssh/authorized_keys` her deseni aşar.

Varsayılanlardan iki sapma, ikisi de bilinçli:
- `failIfUnavailable: true` (zaten varsayılan, öyle kalmalı) — sandbox
  başlayamazsa harness başlamaz. Gözetimsiz bir daemon, kimsenin okumadığı bir
  uyarıyla sandbox'sız çalışmaya düşmemeli.
- `allowUnsandboxedCommands: false` (**varsayılanı `true`**) — açık bırakılırsa
  model bir araç çağrısına `dangerouslyDisableSandbox` koyup sınırın dışına
  çıkabiliyor. Sınırın varlık sebebi bu.

`network.strictAllowlist: true`, `allowedDomains` = `permissions.network_allowlist`,
unix socket yok, local binding yok.

**2. Permission deny kuralları — in-process dosya araçları.**
Bash sandbox'ı `Read`/`Write`/`Edit` araçlarını kapsamıyor. Kritik ayrıntı:
**dosya yazan tüm araçları `Edit(path)` yönetir; `Write(path)` kuralı hiçbir zaman
eşleşmez.** `Write(...)` yazmak koruyormuş gibi görünüp hiçbir şey yapmaz.
`//` deseni dosya sistemi kökünde çapalar.

**3. `screenTool` — kendi politikamız ve denetim izimiz.**
İzin akışında hook'lar ilk sırada koşar, deny kurallarının ve permission mode'un
önünde — `autoAllowBashIfSandboxed` araçları otomatik onaylattığında bile geçerli.
Her reddi `tool_denied` olarak trace'e yazar ve sandbox'ın olmadığı bir platformda
da ayakta kalır.

Ek kurallar: `git`/`gh` yalnız `devops`'a; yazma kapsamı worktree (ana checkout
**okunur, yazılmaz** — worktree'nin bağımlılık dizini oraya symlink); `never_edit`
(`.harness/**`, `.github/workflows/**`); `never_read` (`~/.ssh`, `~/.aws`,
`~/.config/anthropic`, `~/.claude`, `**/.env*`).

Yollar dosya sisteminin çözeceği gibi çözülür: worktree içine dikilen bir symlink
metinsel kontrolü geçip tam da yasaklanan yere yazardı. Kökler de hedefle **aynı
şekilde** çözülür — macOS'ta `/var` → `/private/var` olduğu için aksi halde her
meşru yazma reddedilir ve katman çalışıyormuş gibi görünürken hiçbir şey korumaz.
`~` hem desende hem hedefte genişletilir.

### Doğrulandı, varsayılmadı

Kendi regex'imizin kasıtla geçirdiği bir komutla ölçüldü:

```
komut: echo escaped > /tmp/harness-sandbox-probe.txt
bizim ekran:  ALLOWED
çekirdek:     Exit code 1 — operation not permitted
dosya:        yazılmadı
```

### Kalan risk (dürüstçe)

- Sandbox proxy'si TLS'i sonlandırmıyor; `allowedDomains` istemcinin bildirdiği
  hostname'e bakar. `github.com` gibi geniş bir domain domain fronting ile veri
  sızdırma yolu olabilir. Daha güçlü garanti gerekiyorsa TLS'i sonlandıran özel
  proxy gerekir.
- `runtime.sandbox: container` alanı duruyor; uygulaması MVP dışı.
- Enjeksiyon `main`'e ulaşamaz (`origin: untrusted` asla otomatik merge olmaz,
  `security` hard veto), ama worktree içinde bütçe harcatabilir.

## 10. Hafıza

### `context.md` saklanmıyor — türetiliyor

Her ajana verilen brief bir **render**, bir dosya değil. Kaynakları:

- **`decisions.md`** — yapısı gereği yalnız **merge olmuş** kararları içerir, çünkü
  girdi kodla aynı PR'da yolculuk eder
- **event log** — birden çok görevde tekrar eden blocker'lar

Sonuç: bakımı yapılacak ayrı dosya yok, "scribe bunu ne zaman tazeleyecek" sorusu
yok, ve brief'in hiç merge olmamış bir değişikliği anlatması **imkânsız**.

Prefix cache'in stabil kalma sebebi de bu: metin ancak bir karar merge olduğunda
veya bir tuzak eşiği aştığında değişir, her spawn'da değil.

### Bütçe karakterle ölçülür

`memory.context_budget_chars` (varsayılan 8000, kabaca 2k token). Karakterle,
çünkü **zorlanan şey o**. Token saydığını iddia edip tahmin yürütmek yerine
ölçtüğünü söylemek daha dürüst.

Bütçe aşılınca **bölüm bütünüyle düşer**, cümle ortadan kesilmez: yarıda biten
bir brief olgu gibi okunur.

### Çapa ile son kullanma

Her karar dokunduğu dosyaları çapa olarak taşır. Çapaların tümü kaybolduysa girdi
**depoda kalır** ama ajanlara güncel olgu olarak sunulmaz. Sessizce bayatlamış
hafıza, hiç hafıza olmamasından kötüdür — çünkü ona inanılır.

### İki farklı kimlik, iki farklı iş

- `findingKey` (dosya + özet) → **durma tespiti**: aynı dosya hakkında aynı şikâyet
- `summaryKey` (yalnız özet) → **tuzak**: aynı hata **farklı dosyalarda**, farklı
  görevlerde. Kod tabanının özelliği olması bundan; dosyaya göre anahtarlamak tam
  da hatırlanmaya değer deseni gizlerdi

### Tek yazar, yapısal olarak

`scribe` girdiyi döndürür, **dosyayı harness yazar**. Aynı gerekçe git'te olduğu
gibi: rolün şeridinde kalacağına güvenmek yerine yapıyla zorlamak.
`.harness/**` `never_edit` listesinde — girdiyi yazan rol dahil hiçbir ajan o
dosyaya erişemiyor.

### İddialar depoya karşı doğrulanır

`scribe`'ın verdiği çapalar değişen dosyalarla kesiştirilir. Hiçbiri tutmuyorsa
`flag: unverified_anchors` yazılır ve gerçekten değişen dosyalar kullanılır.
Kalıcı kayda halüsinasyon yazmak bu sistemin yapabileceği en pahalı hata — ondan
sonrası ona inanır.

### Cache sıralaması — ölçüldü

```
[stabil]  rol promptu → brief              ← systemPrompt
[oynak]   görev metni, kriterler, diff     ← prompt
```

Brief'te tarih, task id, sayaç yok. İki ardışık spawn ile ölçüldü:

```
spawn 1  created: 5560  read: 10287
spawn 2  created: 3957  read: 12582
```

`span_end` her spawn için `cache_read_tokens` yazar; sıfır kalması sessiz bir
invalidator'ın işaretidir.

### `decisions.md` kodla atomik merge olur

`scribe`, `verified` ile `integrating` arasında koşar ve girdiyi worktree'ye yazar;
devops onu aynı commit'e alır. Sen kodu onaylarken hafızayı da onaylıyorsun,
uydurma karar satırı review'dan geçemiyor, ve post-merge hook / senkron sorunu yok.

**Quarantine edilen değişiklik karar yazmaz** — merge olan bir şey yok.

## 11. `policy.yaml` (repoda, git'te review edilir)

```yaml
version: 1

repo:                          # scout doldurur, insan düzeltir
  default_branch: main
  test_cmd:  "npm test"
  build_cmd: "npm run build"
  lint_cmd:  "npm run lint"

runtime:
  sandbox: none                # none | container
  max_concurrent_builders: 4
  tick_seconds: 60
  lease_ttl_seconds: 900

roles:
  planner:   { model: claude-opus-5,    effort: high,   maxTurns: 20 }
  builder:   { model: claude-opus-5,    effort: xhigh,  maxTurns: 40 }
  adversary: { model: claude-opus-5,    effort: high,   maxTurns: 25 }
  review:    { model: claude-opus-5,    effort: medium, maxTurns: 15, tools: [] }
  security:  { model: claude-opus-5,    effort: xhigh,  maxTurns: 20, never_downgrade: true, preempt: true }
  devops:    { model: claude-opus-5,    effort: medium, maxTurns: 15 }
  scribe:    { model: claude-haiku-4-5, effort: low,    maxTurns: 6,  tools: [] }

escalation_ladder:             # başarısızlıkta yükselir; ucuz başla
  - { model: claude-sonnet-5, effort: medium }
  - { model: claude-opus-5,   effort: high }
  - { model: claude-opus-5,   effort: xhigh, include_adversary_report: true }
  - { escalate_to_human: true }

ladder_start:                  # script öğrenir, öneri üretir
  trivial: 0
  routine: 0
  risky:   1                   # risky sonnet'ten başlamaz

task_class:
  risky:
    match: ["**/auth/**", "**/crypto/**", "**/*migration*", "package.json",
            ".github/workflows/**", "**/Dockerfile", "**/*secret*"]
    source: [cve-sensor]
    override: { effort: max }
  trivial:
    match: ["**/*.md", "**/*.test.*"]
    source: [todo-harvest]
    max_files: 2
    override: { model: claude-sonnet-5, effort: low }
  routine: {}

routing:                       # (domain, severity) -> lease sahibi
  - { match: "**/auth/**|**/crypto/**|**/*secret*", owner: security }
  - { match: "**/*migration*",                      owner: security }
  - { match: "**/api/**",                           owner: review }
  - { on: ci_failure,                               owner: devops }
  - { default: true,                                owner: planner }

veto:
  security:  { type: hard }
  review:    { type: soft, max_rounds: 2 }
  adversary: { type: soft, max_rounds: 3 }
  devops:    { type: soft, max_rounds: 3 }

budget:
  per_task_usd: 2.00
  per_day_usd: 25.00
  on_exceed: pause             # pause | notify

merge:
  auto: true
  max_pending_escalated: 3
  escalate_when:
    - first_n_merges: 20
    - origin: untrusted
    - task_class: risky
    - security_finding: any
    - review_rounds: ">=2"
    - diff_files: ">15"
    - public_api_change: true
    - acceptance_unmet: any

sensors:
  broken_tests: { enabled: true,  every: "15m", origin: trusted }
  open_issues:  { enabled: true,  every: "30m", origin: untrusted }
  todo_harvest: { enabled: false, every: "24h", origin: trusted }
  cve_scan:     { enabled: false, every: "24h", origin: trusted }

permissions:
  deny_all_roles:
    - "Bash(git *)"
    - "Bash(gh *)"
    - "Bash(rm -rf *)"
  git_allowed_for: [devops]
  never_edit:
    - ".harness/policy.yaml"
    - ".github/workflows/**"
  write_scope: repo_only
  network_allowlist:
    - registry.npmjs.org
    - github.com
    - api.anthropic.com
```

---

## 12. Event / trace şeması

Ayrı tracing sistemi yok. `events.jsonl` zaten trace store; eklenen tek şey `trace_id`.

```jsonl
{"ts":"2026-08-27T10:04:11Z","trace_id":"bk-142","span_id":"s7","parent_span":"s3",
 "type":"span_end","role":"builder","task_id":"bk-142",
 "model":"claude-opus-5","effort":"xhigh","ladder_step":1,
 "cost_usd":0.41,"session_id":"<sdk-session-id>","outcome":"veto:security"}
```

- `trace_id` = backlog item (PR'a birebir karşılık gelir)
- `span_id` = bir ajan koşusu
- `session_id` = SDK'nın kendi transcript'i → ham konuşmaya tıklanır (bedava, SDK diske yazıyor)
- Şekil OTel-uyumlu; ileride export gerekirse dönüştürme kolay

**Event tipleri:** `backlog_add` `task_planned` `span_start` `span_end` `tool_denied`
`veto` `preempt` `lease_acquired` `lease_released` `worktree_open` `worktree_close`
`pr_opened` `pr_ready` `ci_result` `merge` `escalate` `budget_pause` `flag` `revert`

### Maliyet muhasebesi — tuzak
`SDKResultMessage.usage` **subagent tokenlarını saymaz**; sadece top-level loop'u sayar.
Doğru alanlar: `total_cost_usd` (subagent dahil) ve `modelUsage` (model bazında kırılım).
Bütçe kontrolü `usage` üstüne kurulursa gece boyu limitsiz koşar.

### Çökme ve idempotency
- Her durum geçişi, eylemden **önce** `events.jsonl`'a yazılır → restart'ta replay
- Her dış etki `trace_id` türevli idempotency anahtarı taşır
  (`harness/bk-142-*` branch'i varsa ikincisini açma)
- Yarıda kalan ajan `resume` + `session_id` ile kaldığı yerden devam eder

### Prompt cache düzeni
`context.md` her ajan doğuşunda prompt'a girer. Prefix cache için sıra:
```
[stabil] sistem promptu → rol promptu → context.md     ← cache breakpoint
[oynak]  task brief, task-id, timestamp                 ← breakpoint sonrası
```
`context.md`'ye timestamp/task-id yazmak **yasak** — bir byte değişirse sonrası invalidate.
`scribe` tur içinde değil, yalnız merge sonrası yazar (ikinci gerekçe).
`usage.cache_read_input_tokens` sıfırsa sessiz bir invalidator vardır.

---

## 13. Dizin düzeni

**Kural: yeniden üretilebilen sidecar'a, yeri doldurulamaz repoya.**

```
<repo>/.harness/
  policy.yaml        insan elle ayarlar, git'te review edilir
  decisions.md       append-only, yeri doldurulamaz

~/.harness/<repo-slug>/
  events.jsonl       gürültü + trace store
  context.md         türetilmiş, silinse yeniden üretilir
  repo.md            türetilmiş (scout tekrar koşar)
  backlog.jsonl
  tasks/<id>.json
  leases.json
  state              running | paused
  worktrees/
```

---

## 14. CLI yüzeyi

```
harness init                 policy.yaml + scout, repo profili çıkar
harness start [--detach]     daemon
harness stop | pause | resume
harness status               canlı span tablosu, bütçe, açık PR'lar
harness trace <trace_id>     ağaç: spawn → tool → veto → retry → PR
harness stats                gün/maliyet, task_class başına tur-1 başarı,
                             hangi rol en çok blokluyor
harness log [--follow]
harness ui                   localhost:7777, SSE, tek HTML dosya
harness revert <trace_id>
harness backlog add "<iş>"   origin: trusted
```

`harness stats`'ın son sütunu en değerlisi: `review` sürekli aynı şeye takılıyorsa
o bir `policy.yaml` kuralı olmalı, her seferinde LLM turu değil.

---

## 15. Stack

```
runtime    Node 22+
CLI        node:util parseArgs        (stdlib)
config     yaml + zod                 (policy doğrulama)
git        child_process → git        (simple-git gereksiz)
github     child_process → gh         (octokit gereksiz)
events     fs.appendFile → jsonl      (DB yok)
dashboard  node:http + SSE + 1 HTML   (framework yok)
zamanlama  setInterval, daemon içi    (cron dep yok)
test       node:test + node:assert    (stdlib)
```

**Üçüncü parti bağımlılık: 3** — `@anthropic-ai/claude-agent-sdk`, `yaml`, `zod`.

Dağıtım: `npx harness init`. Repo başına bir daemon, bütçe repo başına.

### SDK eşleşmesi
Rol başına model/efor için kod yazmıyoruz — `AgentDefinition` zaten kabul ediyor:
```ts
type AgentDefinition = {
  description: string; prompt: string
  model?: string
  effort?: 'low'|'medium'|'high'|'xhigh'|'max'|number
  maxTurns?: number
  tools?: string[]; disallowedTools?: string[]
  permissionMode?: PermissionMode
  background?: boolean; skills?: string[]
}
```
`review`/`scribe` = `tools: []` olan subagent. Ayrı bir "judge" arayüzü yok.

---

## 16. Faz planı

| Faz | İçerik | Biterken doğrulanan |
|---|---|---|
| 0 | Daemon tick, `events.jsonl`, policy yükle+zod doğrula, `status` | İskelet ayakta |
| 1 | `planner` → `builder` → `devops` → PR. Auto-merge **kapalı**, hepsi escalate | Uçtan uca tek zincir |
| 2 | `adversary` + `review` + veto döngüsü + kabul kriteri sözleşmesi | Geri besleme çalışıyor |
| 3 | `security` + preempt + quarantine + deny/`canUseTool`/ağ allowlist | Güvenlik modeli yerinde |
| 4 | `scribe` + `context.md` + cache düzeni + `decisions.md` PR içinde | Hafıza taşınıyor |
| 5 | Sensörler + always-on + WIP + bütçe korkulukları | Gözetimsiz koşuyor |
| 6 | `trace`, `stats`, `ui` | Görünürlük |
| 7 | Auto-merge açılışı (`first_n_merges` sayacı) | Otonomi kazanıldı |

Auto-merge bilerek **en sona**: güven ölçülerek açılır.

---

## 17. Bilinen sınırlar

- Süreç izolasyonu yok (`sandbox: none`). Enjeksiyon merge'e ulaşamaz ama
  worktree'de komut çalıştırabilir. `container` alanı hazır, uygulaması MVP dışı.
- GitHub zorunlu. Remote yoksa harness başlamaz; ikinci onay yolu yok.
- Tek provider (Claude / Agent SDK). Provider soyutlaması bilinçli olarak yok —
  Agent SDK'nın loop/tool/context/permission katmanını yeniden yazma maliyeti kabul edilmedi.
- Tek makine, tek kullanıcı. Web app'e çevirme çok-kullanıcı senaryosu geldiğinde.
- `ladder_start` öğrenmesi öneri üretir, otomatik uygulamaz — `policy.yaml` insan onaylı kalır.
