package config

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
)

// adminPasswordIterations matches the dashboard's accepted PBKDF2 cost so a
// hash generated here verifies on the web side without re-tuning.
const adminPasswordIterations = 210_000

// InstallationSecrets contains the service credentials generated for a new
// launcher-managed installation.
type InstallationSecrets struct {
	LiteLLMMasterKey string
	LiteLLMSaltKey   string
	PostgresPassword string
	Neo4jPassword    string
}

// DefaultAdminUsername matches the web dashboard's own default and the value
// written to .env by the install-time migrations.
const DefaultAdminUsername = "admin"

// AdminUsername reads the configured dashboard account name, falling back to
// the shared default.
func AdminUsername(env map[string]string) string {
	if value := strings.TrimSpace(env["DECEPTICON_ADMIN_USERNAME"]); value != "" {
		return value
	}
	return DefaultAdminUsername
}

// AdminPasswordHash is a freshly generated dashboard credential: the plaintext
// to show the operator once, and the digest to persist.
type AdminPasswordHash struct {
	Password string
	Hash     string
}

// NewSessionSecret returns a 32-byte hex key for signing the dashboard session
// cookie.
func NewSessionSecret() (string, error) {
	secret, err := randomHex(32)
	if err != nil {
		return "", fmt.Errorf("generate session secret: %w", err)
	}
	return secret, nil
}

// NewInternalApiToken returns the shared secret in-container callers use to
// reach the dashboard API without a browser cookie (the terminal server
// persisting a thread id). It never reaches the browser, so it only has to be
// unguessable.
func NewInternalApiToken() (string, error) {
	token, err := randomHex(32)
	if err != nil {
		return "", fmt.Errorf("generate internal API token: %w", err)
	}
	return token, nil
}

// NewAdminPasswordHash generates a random passphrase and the PBKDF2-SHA256
// digest the dashboard verifies against (`pbkdf2$sha256$<iterations>$<salt>$<key>`,
// the same format the Go standard library and the web auth module share).
// 210k iterations matches the dashboard's own accepted parameters.
func NewAdminPasswordHash() (AdminPasswordHash, error) {
	password, err := randomPassword(24)
	if err != nil {
		return AdminPasswordHash{}, fmt.Errorf("generate admin password: %w", err)
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return AdminPasswordHash{}, fmt.Errorf("generate admin salt: %w", err)
	}
	key, err := pbkdf2.Key(sha256.New, password, salt, adminPasswordIterations, 32)
	if err != nil {
		return AdminPasswordHash{}, fmt.Errorf("derive admin password hash: %w", err)
	}
	return AdminPasswordHash{
		Password: password,
		Hash: fmt.Sprintf("pbkdf2$sha256$%d$%s$%s",
			adminPasswordIterations, hex.EncodeToString(salt), hex.EncodeToString(key)),
	}, nil
}

// randomPassword builds an unambiguous passphrase: no look-alike characters
// (0/O, 1/l/I) so an operator can retype it from a terminal.
func randomPassword(length int) (string, error) {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
	value := make([]byte, length)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	for i, b := range value {
		value[i] = alphabet[int(b)%len(alphabet)]
	}
	return string(value), nil
}

// NewInstallationSecrets generates independent credentials for every service
// that otherwise inherits a public development default from .env.example.
func NewInstallationSecrets() (InstallationSecrets, error) {
	masterKey, err := randomHex(32)
	if err != nil {
		return InstallationSecrets{}, fmt.Errorf("generate LiteLLM master key: %w", err)
	}
	saltKey, err := randomHex(32)
	if err != nil {
		return InstallationSecrets{}, fmt.Errorf("generate LiteLLM salt key: %w", err)
	}
	postgresPassword, err := randomHex(24)
	if err != nil {
		return InstallationSecrets{}, fmt.Errorf("generate Postgres password: %w", err)
	}
	neo4jPassword, err := randomHex(32)
	if err != nil {
		return InstallationSecrets{}, fmt.Errorf("generate Neo4j password: %w", err)
	}

	return InstallationSecrets{
		LiteLLMMasterKey: "sk-" + masterKey,
		LiteLLMSaltKey:   "sk-" + saltKey,
		PostgresPassword: postgresPassword,
		Neo4jPassword:    neo4jPassword,
	}, nil
}

func randomHex(byteLength int) (string, error) {
	value := make([]byte, byteLength)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("read operating-system randomness: %w", err)
	}
	return hex.EncodeToString(value), nil
}
