package config

import (
	"crypto/pbkdf2"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
)

func TestNewInstallationSecrets_generates_nondefault_credentials(t *testing.T) {
	// Given
	const defaultMasterKey = "sk-decepticon-master"
	const defaultDatabasePassword = "decepticon"

	// When
	secrets, err := NewInstallationSecrets()

	// Then
	if err != nil {
		t.Fatalf("NewInstallationSecrets() error = %v", err)
	}
	if secrets.LiteLLMMasterKey == defaultMasterKey {
		t.Fatal("LiteLLM master key must not use the public default")
	}
	if secrets.PostgresPassword == defaultDatabasePassword {
		t.Fatal("Postgres password must not use the public default")
	}
	if !strings.HasPrefix(secrets.LiteLLMMasterKey, "sk-") {
		t.Fatalf("LiteLLM master key = %q, want sk- prefix", secrets.LiteLLMMasterKey)
	}
	wantLengths := map[string]int{
		secrets.LiteLLMMasterKey: 67,
		secrets.LiteLLMSaltKey:   67,
		secrets.PostgresPassword: 48,
		secrets.Neo4jPassword:    64,
	}
	for value, want := range wantLengths {
		if len(value) != want {
			t.Fatalf("generated credential length = %d, want %d", len(value), want)
		}
	}
}

func TestNewInstallationSecrets_generates_independent_values(t *testing.T) {
	// Given
	const generatedSecretCount = 4

	// When
	secrets, err := NewInstallationSecrets()

	// Then
	if err != nil {
		t.Fatalf("NewInstallationSecrets() error = %v", err)
	}
	values := map[string]struct{}{
		secrets.LiteLLMMasterKey: {},
		secrets.LiteLLMSaltKey:   {},
		secrets.PostgresPassword: {},
		secrets.Neo4jPassword:    {},
	}
	if len(values) != generatedSecretCount {
		t.Fatalf("generated %d unique values, want %d", len(values), generatedSecretCount)
	}
}

func TestNewSessionSecret_generates_distinct_hex_keys(t *testing.T) {
	// Given / When
	first, err := NewSessionSecret()
	if err != nil {
		t.Fatalf("NewSessionSecret() error = %v", err)
	}
	second, err := NewSessionSecret()
	if err != nil {
		t.Fatalf("NewSessionSecret() error = %v", err)
	}

	// Then
	if len(first) != 64 {
		t.Fatalf("session secret length = %d, want 64 hex chars", len(first))
	}
	if first == second {
		t.Fatal("session secrets must not repeat")
	}
}

func TestNewAdminPasswordHash_matches_the_web_verification_format(t *testing.T) {
	// Given / When
	generated, err := NewAdminPasswordHash()
	if err != nil {
		t.Fatalf("NewAdminPasswordHash() error = %v", err)
	}
	parts := strings.Split(generated.Hash, "$")

	// Then — pbkdf2$sha256$<iterations>$<saltHex>$<keyHex>
	if len(parts) != 5 {
		t.Fatalf("hash = %q, want 5 segments", generated.Hash)
	}
	if parts[0] != "pbkdf2" || parts[1] != "sha256" {
		t.Fatalf("algorithm = %s/%s, want pbkdf2/sha256", parts[0], parts[1])
	}
	if parts[2] != "210000" {
		t.Fatalf("iterations = %s, want 210000", parts[2])
	}
	if len(parts[3]) != 32 || len(parts[4]) != 64 {
		t.Fatalf("salt/key lengths = %d/%d, want 32/64", len(parts[3]), len(parts[4]))
	}
	if len(generated.Password) != 24 {
		t.Fatalf("password length = %d, want 24", len(generated.Password))
	}

	// The stored digest must reproduce from the plaintext we hand the operator.
	salt, err := hex.DecodeString(parts[3])
	if err != nil {
		t.Fatalf("salt is not hex: %v", err)
	}
	key, err := pbkdf2.Key(sha256.New, generated.Password, salt, adminPasswordIterations, 32)
	if err != nil {
		t.Fatalf("pbkdf2.Key: %v", err)
	}
	if hex.EncodeToString(key) != parts[4] {
		t.Fatal("stored key does not derive from the generated password")
	}
}

func TestRandomPassword_avoids_lookalike_characters(t *testing.T) {
	// Given / When
	password, err := randomPassword(64)
	if err != nil {
		t.Fatalf("randomPassword() error = %v", err)
	}

	// Then — no 0/O/1/l/I, so the operator can retype it from a terminal.
	if strings.ContainsAny(password, "0O1lI") {
		t.Fatalf("password %q contains a look-alike character", password)
	}
}
