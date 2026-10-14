package migrate

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"charm.land/huh/v2"

	"github.com/PurpleAILAB/Decepticon/clients/launcher/internal/config"
	"github.com/PurpleAILAB/Decepticon/clients/launcher/internal/ui"
)

// TelemetryPolicyID identifies the one-time telemetry re-consent prompt.
// Bumping the date suffix (a new step ID) re-asks every user again after a
// future policy change.
const TelemetryPolicyID = "telemetry-policy-2026-06"

// confirm is indirected so tests can answer the prompt without a TTY.
var confirm = func(title, description, affirmative, negative string, defaultYes bool) bool {
	v := defaultYes
	if err := huh.NewConfirm().
		Title(title).
		Description(description).
		Affirmative(affirmative).
		Negative(negative).
		Value(&v).
		Run(); err != nil {
		// A prompt error (e.g. aborted) must not silently enable a
		// data-collection setting — fail to the conservative answer.
		return false
	}
	return v
}

// Registry is the ordered list of migrations applied at every start.
// Append a Step here to ship a future config/policy migration.
// DashboardCredentialID is the non-interactive step that gives an
// already-onboarded install its dashboard sign-in material: the session
// signing key, and (if the user has not chosen one) an administrator password
// derived from a generated passphrase. A non-empty password-hash means the
// user manages this themselves and nothing is touched.
const DashboardCredentialID = "dashboard-auth"

func Registry() []Step {
	return []Step{
		{
			ID:          "env-backfill",
			Description: "Backfill newly-added env.example keys into an existing .env",
			Interactive: false,
			Apply:       applyEnvBackfill,
		},
		{
			ID:          DashboardCredentialID,
			Description: "Generate dashboard sign-in material when it is missing",
			Interactive: false,
			Apply:       applyDashboardCredentials,
		},
		{
			ID:          TelemetryPolicyID,
			Description: "Re-ask telemetry consent after the opt-out policy change",
			Interactive: true,
			Apply:       applyTelemetryReconsent,
		},
	}
}

// applyDashboardCredentials gives an install its dashboard sign-in material:
// the session signing key, the in-container shared secret, and (if the user
// has not chosen one) an administrator password derived from a generated
// passphrase. A credential the user already configured — scrypt/pbkdf2 hash or
// plaintext password — is left untouched: silently replacing it would lock the
// operator out of a live session.
func applyDashboardCredentials(c *Ctx) (string, error) {
	values := map[string]string{}

	if strings.TrimSpace(c.Env["DECEPTICON_SESSION_SECRET"]) == "" {
		secret, err := config.NewSessionSecret()
		if err != nil {
			return "", err
		}
		values["DECEPTICON_SESSION_SECRET"] = secret
	}

	// Without this token the terminal server cannot persist a thread id: it
	// holds no browser cookie, so its PATCH would answer 401.
	if strings.TrimSpace(c.Env["DECEPTICON_INTERNAL_API_TOKEN"]) == "" {
		token, err := config.NewInternalApiToken()
		if err != nil {
			return "", err
		}
		values["DECEPTICON_INTERNAL_API_TOKEN"] = token
	}

	managed := strings.TrimSpace(c.Env["DECEPTICON_ADMIN_PASSWORD_HASH"]) != "" ||
		strings.TrimSpace(c.Env["DECEPTICON_ADMIN_PASSWORD"]) != ""
	if managed || len(values) == 0 {
		if err := config.SetEnvKeys(c.EnvPath, values); err != nil {
			return "", err
		}
		applyToEnv(c.Env, values)
		if managed && len(values) > 0 {
			return "Generated the dashboard session/internal secrets; your configured administrator credential is unchanged.", nil
		}
		return "", nil
	}

	generated, err := config.NewAdminPasswordHash()
	if err != nil {
		return "", err
	}
	values["DECEPTICON_ADMIN_PASSWORD_HASH"] = generated.Hash
	values["DECEPTICON_ADMIN_USERNAME"] = config.AdminUsername(c.Env)
	if err := config.SetEnvKeys(c.EnvPath, values); err != nil {
		return "", err
	}
	applyToEnv(c.Env, values)

	// Printed exactly once: the stored hash is one-way, so this is the
	// operator's only chance to record the password.
	ui.Info("Web dashboard password (stored only as a hash — record it now):")
	ui.Info(fmt.Sprintf("  %s  →  user %s  password %s",
		config.EnvPath(), values["DECEPTICON_ADMIN_USERNAME"], generated.Password))
	return "Generated a dashboard administrator password; see the line above.", nil
}

// applyToEnv mirrors written keys into the in-memory env so the rest of
// `start` this run sees them without a reload.
func applyToEnv(env, values map[string]string) {
	for key, value := range values {
		env[key] = value
	}
}

func applyEnvBackfill(c *Ctx) (string, error) {
	added, err := config.BackfillEnvFromEmbed(c.EnvPath)
	if err != nil {
		return "", err
	}
	if len(added) == 0 {
		return "", nil
	}
	// Reflect the new keys into the in-memory env so the rest of `start`
	// sees them this run (without clobbering anything already loaded).
	if reloaded, lerr := config.LoadEnv(c.EnvPath); lerr == nil {
		for k, v := range reloaded {
			if _, ok := c.Env[k]; !ok {
				c.Env[k] = v
			}
		}
	}
	shown := added
	const cap = 8
	suffix := ""
	if len(added) > cap {
		shown = added[:cap]
		suffix = fmt.Sprintf(", +%d more", len(added)-cap)
	}
	return fmt.Sprintf(
		"Added %d new config key(s) to .env: %s%s (backup at %s.bak)",
		len(added), strings.Join(shown, ", "), suffix, c.EnvPath,
	), nil
}

const telemetryConsentBlurb = "" +
	"Decepticon is free and open source. Sharing anonymous usage helps fund\n" +
	"and improve it, and — with your consent — contributes masked red-team\n" +
	"reasoning to train future open offensive-security agents.\n\n" +
	"What is shared (research tier):\n" +
	"  • anonymous structural stats (tools used, finding severity/CWE, phase)\n" +
	"  • the agent's red-team REASONING, with target identifiers MASKED\n" +
	"    (10.0.0.5 -> <HOST_1>, acme.com -> <DOMAIN_1>)\n\n" +
	"Never sent at any tier: raw prompts, real target IPs/hosts, credentials.\n" +
	"Your IP is dropped at the gateway.\n\n" +
	"You can change this anytime: set DECEPTICON_TELEMETRY=off (or basic) in\n" +
	"~/.decepticon/.env, run `decepticon-cli telemetry off`, or DO_NOT_TRACK=1."

func applyTelemetryReconsent(c *Ctx) (string, error) {
	// Honor hard opt-outs without prompting (and record the ack so we
	// never re-ask): DO_NOT_TRACK, or the persistent opt-out marker
	// written by `decepticon-cli telemetry off`.
	if truthy(os.Getenv("DO_NOT_TRACK")) || truthy(c.Env["DO_NOT_TRACK"]) || hasOptOutMarker(c.Home) {
		return "", nil
	}

	consent := confirm(
		"Share anonymous + masked red-team telemetry?",
		telemetryConsentBlurb,
		"Yes, share",
		"No, keep it off (recommended)",
		false, // default No — telemetry is opt-in
	)

	mode := "research"
	if !consent {
		mode = "off"
	}
	if err := config.SetEnvKey(c.EnvPath, "DECEPTICON_TELEMETRY", mode); err != nil {
		return "", err
	}
	c.Env["DECEPTICON_TELEMETRY"] = mode

	if consent {
		return "Telemetry: research tier enabled (identifiers masked). " +
			"Disable anytime with DECEPTICON_TELEMETRY=off or DO_NOT_TRACK=1.", nil
	}
	return "Telemetry: kept off.", nil
}

// hasOptOutMarker mirrors the Python config's persistent opt-out marker at
// $DECEPTICON_HOME/telemetry/opt_out (decepticon_core/.../telemetry).
func hasOptOutMarker(home string) bool {
	_, err := os.Stat(filepath.Join(home, "telemetry", "opt_out"))
	return err == nil
}

func truthy(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}
