package migrate

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/PurpleAILAB/Decepticon/clients/launcher/internal/config"
)

func newTestCtx(t *testing.T, env map[string]string, tty bool) *Ctx {
	t.Helper()
	home := t.TempDir()
	envPath := filepath.Join(home, ".env")
	// A minimal .env so file-writing steps have something to edit.
	if _, ok := env["DECEPTICON_TELEMETRY"]; ok {
		_ = os.WriteFile(envPath, []byte("DECEPTICON_TELEMETRY="+env["DECEPTICON_TELEMETRY"]+"\n"), 0o600)
	} else {
		_ = os.WriteFile(envPath, []byte("FOO=bar\n"), 0o600)
	}
	c := &Ctx{
		EnvPath: envPath,
		Env:     env,
		Home:    home,
		IsTTY:   tty,
		ackPath: filepath.Join(home, ackFileName),
	}
	c.loadAcks()
	return c
}

func TestRun_NonInteractiveStepAlwaysRuns(t *testing.T) {
	c := newTestCtx(t, map[string]string{}, false)
	ran := 0
	Run(c, []Step{{
		ID:          "noninteractive",
		Interactive: false,
		Apply:       func(_ *Ctx) (string, error) { ran++; return "", nil },
	}})
	if ran != 1 {
		t.Fatalf("non-interactive step ran %d times, want 1", ran)
	}
	// Non-interactive steps are never ack-recorded (they re-run each start).
	if c.Acked("noninteractive") {
		t.Error("non-interactive step should not be ack-recorded")
	}
}

func TestRun_InteractiveDeferredOnNonTTY(t *testing.T) {
	c := newTestCtx(t, map[string]string{}, false)
	ran := 0
	step := Step{
		ID:          "consent",
		Interactive: true,
		Apply:       func(_ *Ctx) (string, error) { ran++; return "", nil },
	}
	Run(c, []Step{step})
	if ran != 0 {
		t.Fatalf("interactive step ran on non-TTY (%d), want deferred", ran)
	}
	if c.Acked("consent") {
		t.Error("deferred step must not be acked")
	}
}

func TestRun_InteractiveRunsOnceThenAcked(t *testing.T) {
	c := newTestCtx(t, map[string]string{}, true)
	ran := 0
	step := Step{
		ID:          "consent",
		Interactive: true,
		Apply:       func(_ *Ctx) (string, error) { ran++; return "ok", nil },
	}
	Run(c, []Step{step})
	Run(c, []Step{step}) // second start: already acked
	if ran != 1 {
		t.Fatalf("interactive step ran %d times, want exactly 1", ran)
	}
	if !c.Acked("consent") {
		t.Error("interactive step should be acked after running")
	}
	// Ack persists across a fresh Ctx (simulating a new process).
	c2 := &Ctx{ackPath: c.ackPath}
	c2.loadAcks()
	if !c2.Acked("consent") {
		t.Error("ack did not persist to disk")
	}
}

func TestTelemetryReconsent_Yes(t *testing.T) {
	defer swapConfirm(true)()
	c := newTestCtx(t, map[string]string{"DECEPTICON_TELEMETRY": "off"}, true)
	if _, err := applyTelemetryReconsent(c); err != nil {
		t.Fatalf("applyTelemetryReconsent: %v", err)
	}
	assertEnvKey(t, c.EnvPath, "DECEPTICON_TELEMETRY", "research")
	if c.Env["DECEPTICON_TELEMETRY"] != "research" {
		t.Errorf("in-memory env not updated: %q", c.Env["DECEPTICON_TELEMETRY"])
	}
}

func TestTelemetryReconsent_No(t *testing.T) {
	defer swapConfirm(false)()
	c := newTestCtx(t, map[string]string{"DECEPTICON_TELEMETRY": "off"}, true)
	if _, err := applyTelemetryReconsent(c); err != nil {
		t.Fatalf("applyTelemetryReconsent: %v", err)
	}
	assertEnvKey(t, c.EnvPath, "DECEPTICON_TELEMETRY", "off")
}

func TestTelemetryReconsent_HardOptOutDoNotTrack(t *testing.T) {
	// DO_NOT_TRACK must skip the prompt entirely and leave the value alone.
	called := false
	restore := confirm
	confirm = func(_, _, _, _ string, _ bool) bool { called = true; return true }
	defer func() { confirm = restore }()

	c := newTestCtx(t, map[string]string{"DECEPTICON_TELEMETRY": "off", "DO_NOT_TRACK": "1"}, true)
	if _, err := applyTelemetryReconsent(c); err != nil {
		t.Fatalf("applyTelemetryReconsent: %v", err)
	}
	if called {
		t.Error("prompt shown despite DO_NOT_TRACK")
	}
	assertEnvKey(t, c.EnvPath, "DECEPTICON_TELEMETRY", "off")
}

func TestTelemetryReconsent_HardOptOutMarker(t *testing.T) {
	called := false
	restore := confirm
	confirm = func(_, _, _, _ string, _ bool) bool { called = true; return true }
	defer func() { confirm = restore }()

	c := newTestCtx(t, map[string]string{"DECEPTICON_TELEMETRY": "off"}, true)
	markerDir := filepath.Join(c.Home, "telemetry")
	if err := os.MkdirAll(markerDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(markerDir, "opt_out"), []byte("opted out\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := applyTelemetryReconsent(c); err != nil {
		t.Fatalf("applyTelemetryReconsent: %v", err)
	}
	if called {
		t.Error("prompt shown despite opt-out marker")
	}
	assertEnvKey(t, c.EnvPath, "DECEPTICON_TELEMETRY", "off")
}

func TestEnvBackfillStepReflectsIntoEnv(t *testing.T) {
	c := newTestCtx(t, map[string]string{"DECEPTICON_TELEMETRY": "off"}, false)
	if _, err := applyEnvBackfill(c); err != nil {
		t.Fatalf("applyEnvBackfill: %v", err)
	}
	// The endpoint (a template default missing from the seed) should now be
	// both on disk and reflected into the in-memory env map.
	if c.Env["DECEPTICON_TELEMETRY_ENDPOINT"] == "" {
		t.Error("backfilled key not reflected into in-memory env")
	}
}

// TestRunAll_ExistingUserUpgrade exercises the fully wired path an existing
// (pre-endpoint) user hits at `decepticon start`: env-backfill adds the
// telemetry endpoint their .env never had, and the one-time re-consent
// prompt flips them to research — then never fires again.
func TestRunAll_ExistingUserUpgrade(t *testing.T) {
	home := t.TempDir()
	t.Setenv("DECEPTICON_HOME", home)
	envPath := filepath.Join(home, ".env")
	// A pre-#706 .env: telemetry off, NO endpoint key at all.
	if err := os.WriteFile(envPath, []byte("DECEPTICON_TELEMETRY=off\nANTHROPIC_API_KEY=sk-real\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	defer swapConfirm(true)()
	restoreTTY := isInteractive
	isInteractive = func() bool { return true }
	defer func() { isInteractive = restoreTTY }()

	env, err := config.LoadEnv(envPath)
	if err != nil {
		t.Fatal(err)
	}
	RunAll(env)

	got, err := config.LoadEnv(envPath)
	if err != nil {
		t.Fatal(err)
	}
	if got["DECEPTICON_TELEMETRY_ENDPOINT"] == "" {
		t.Error("endpoint not backfilled for existing user")
	}
	if got["DECEPTICON_TELEMETRY"] != "research" {
		t.Errorf("DECEPTICON_TELEMETRY = %q, want research after consent", got["DECEPTICON_TELEMETRY"])
	}
	if got["ANTHROPIC_API_KEY"] != "sk-real" {
		t.Errorf("real key not preserved: %q", got["ANTHROPIC_API_KEY"])
	}

	// Second start: consent must NOT be asked again.
	asked := false
	confirm = func(_, _, _, _ string, _ bool) bool { asked = true; return true }
	env2, _ := config.LoadEnv(envPath)
	RunAll(env2)
	if asked {
		t.Error("re-consent prompt fired a second time (ack not honored)")
	}
}

// --- helpers ---

func swapConfirm(answer bool) func() {
	restore := confirm
	confirm = func(_, _, _, _ string, _ bool) bool { return answer }
	return func() { confirm = restore }
}

func assertEnvKey(t *testing.T, path, key, want string) {
	t.Helper()
	env, err := config.LoadEnv(path)
	if err != nil {
		t.Fatalf("LoadEnv: %v", err)
	}
	if env[key] != want {
		t.Errorf("%s = %q, want %q", key, env[key], want)
	}
}

func TestDashboardCredentials_generate_when_unconfigured(t *testing.T) {
	// Given — a fresh .env with neither a session secret nor a credential.
	c := newTestCtx(t, map[string]string{}, false)

	// When
	note, err := applyDashboardCredentials(c)

	// Then
	if err != nil {
		t.Fatalf("applyDashboardCredentials: %v", err)
	}
	if note == "" {
		t.Error("expected a note so the operator learns a password was created")
	}
	env, err := config.LoadEnv(c.EnvPath)
	if err != nil {
		t.Fatalf("LoadEnv: %v", err)
	}
	if len(env["DECEPTICON_SESSION_SECRET"]) != 64 {
		t.Errorf("session secret = %q, want 64 hex chars", env["DECEPTICON_SESSION_SECRET"])
	}
	if env["DECEPTICON_ADMIN_USERNAME"] != config.DefaultAdminUsername {
		t.Errorf("username = %q, want %q", env["DECEPTICON_ADMIN_USERNAME"], config.DefaultAdminUsername)
	}
	if len(env["DECEPTICON_INTERNAL_API_TOKEN"]) != 64 {
		t.Errorf("internal token = %q, want 64 hex chars", env["DECEPTICON_INTERNAL_API_TOKEN"])
	}
	if !strings.HasPrefix(env["DECEPTICON_ADMIN_PASSWORD_HASH"], "pbkdf2$sha256$210000$") {
		t.Errorf("password hash = %q, want a pbkdf2 digest", env["DECEPTICON_ADMIN_PASSWORD_HASH"])
	}
	if c.Env["DECEPTICON_SESSION_SECRET"] != env["DECEPTICON_SESSION_SECRET"] {
		t.Error("in-memory env did not pick up the session secret")
	}

	// A second start must not rotate what the operator is already using.
	before := env["DECEPTICON_ADMIN_PASSWORD_HASH"]
	beforeToken := env["DECEPTICON_INTERNAL_API_TOKEN"]
	reloaded, _ := config.LoadEnv(c.EnvPath)
	c2 := &Ctx{EnvPath: c.EnvPath, Env: reloaded, Home: c.Home, IsTTY: false, ackPath: c.ackPath}
	if _, err := applyDashboardCredentials(c2); err != nil {
		t.Fatalf("second applyDashboardCredentials: %v", err)
	}
	assertEnvKey(t, c.EnvPath, "DECEPTICON_ADMIN_PASSWORD_HASH", before)
	assertEnvKey(t, c.EnvPath, "DECEPTICON_INTERNAL_API_TOKEN", beforeToken)
}

func TestDashboardCredentials_preserve_an_operator_managed_hash(t *testing.T) {
	// Given — the operator already generated their own scrypt hash.
	hash := "scrypt$0123456789abcdef0123456789abcdef$" + strings.Repeat("ab", 32)
	c := newTestCtx(t, map[string]string{"DECEPTICON_ADMIN_PASSWORD_HASH": hash}, false)
	// The test context seeds .env from the telemetry key only; write the hash in.
	if err := config.SetEnvKey(c.EnvPath, "DECEPTICON_ADMIN_PASSWORD_HASH", hash); err != nil {
		t.Fatalf("seed hash: %v", err)
	}

	// When
	if _, err := applyDashboardCredentials(c); err != nil {
		t.Fatalf("applyDashboardCredentials: %v", err)
	}

	// Then — the hash is untouched, only the missing session secret is added.
	assertEnvKey(t, c.EnvPath, "DECEPTICON_ADMIN_PASSWORD_HASH", hash)
	env, _ := config.LoadEnv(c.EnvPath)
	if len(env["DECEPTICON_SESSION_SECRET"]) != 64 {
		t.Error("session secret should still be generated")
	}
}

func TestDashboardCredentials_preserve_a_plaintext_password(t *testing.T) {
	c := newTestCtx(t, map[string]string{}, false)
	if err := config.SetEnvKey(c.EnvPath, "DECEPTICON_ADMIN_PASSWORD", "operator-chosen"); err != nil {
		t.Fatalf("seed password: %v", err)
	}
	c.Env["DECEPTICON_ADMIN_PASSWORD"] = "operator-chosen"

	if _, err := applyDashboardCredentials(c); err != nil {
		t.Fatalf("applyDashboardCredentials: %v", err)
	}
	env, _ := config.LoadEnv(c.EnvPath)
	if env["DECEPTICON_ADMIN_PASSWORD"] != "operator-chosen" {
		t.Errorf("password = %q, want it preserved", env["DECEPTICON_ADMIN_PASSWORD"])
	}
	if env["DECEPTICON_ADMIN_PASSWORD_HASH"] != "" {
		t.Error("no competing hash should be written over a plaintext password")
	}
}

func TestRegistry_includes_the_dashboard_credential_step(t *testing.T) {
	found := false
	for _, step := range Registry() {
		if step.ID == DashboardCredentialID {
			found = true
			if step.Interactive {
				t.Error("dashboard credentials must be provisioned without a prompt")
			}
		}
	}
	if !found {
		t.Fatal("dashboard credential step missing from Registry()")
	}
}
