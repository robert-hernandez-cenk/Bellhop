// Package httpapi implements the gateway's management API (GET /status,
// GET /servers, GET /cities, GET /groups, POST /connect) -- deliberately
// unauthenticated (LAN-only trust model).
package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"time"

	"vpn-gateway-agent/provider"
	"vpn-gateway-agent/publicip"
	"vpn-gateway-agent/state"
	"vpn-gateway-agent/wireguard"
)

// WireguardManager is the subset of *wireguard.Manager httpapi depends on --
// an interface (not the concrete type) so tests can substitute a fake that
// never shells out to wg-quick/wg.
type WireguardManager interface {
	Up(peer provider.PeerConfig) error
	Down() error
}

type Deps struct {
	Provider   provider.Provider
	WG         WireguardManager
	StatePath  string
	PrivateKey string
	// Now is injected for deterministic tests; nil in production (handlers
	// fall back to time.Now).
	Now func() time.Time
	// ResolvePublicIP resolves the tunnel's public egress IP for tunnelIP
	// (the wg0 interface's own address, stripped of its CIDR suffix).
	// Overridable in tests to avoid a real network call to api.ipify.org;
	// nil in production uses publicip.NewTunnelClient +
	// publicip.ResolvePublicIP. A resolution failure is non-fatal -- the
	// caller treats it the same as an empty string.
	ResolvePublicIP func(ctx context.Context, tunnelIP string) (string, error)
}

func (d Deps) now() time.Time {
	if d.Now != nil {
		return d.Now()
	}
	return time.Now()
}

func (d Deps) resolvePublicIP(ctx context.Context, tunnelIP string) string {
	resolve := d.ResolvePublicIP
	if resolve == nil {
		resolve = func(ctx context.Context, tunnelIP string) (string, error) {
			client := publicip.NewTunnelClient(tunnelIP)
			// See publicip.NewTunnelClient's doc comment: this agent is
			// long-running and reconnects periodically via self-heal, so
			// without this the pooled connection and its read/write-loop
			// goroutines would leak on every call.
			defer client.CloseIdleConnections()
			return publicip.ResolvePublicIP(ctx, client, "")
		}
	}
	ip, err := resolve(ctx, tunnelIP)
	if err != nil {
		return ""
	}
	return ip
}

func NewHandler(deps Deps) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /status", deps.handleStatus)
	mux.HandleFunc("GET /servers", deps.handleServers)
	mux.HandleFunc("GET /cities", deps.handleCities)
	mux.HandleFunc("GET /groups", deps.handleGroups)
	mux.HandleFunc("POST /connect", deps.handleConnect)
	return mux
}

type statusResponse struct {
	Connected         bool      `json:"connected"`
	Country           string    `json:"country"`
	ResolvedCountry   string    `json:"resolvedCountry"`
	City              string    `json:"city"`
	ResolvedCity      string    `json:"resolvedCity"`
	Group             string    `json:"group"`
	PublicIP          string    `json:"publicIp"`
	Server            string    `json:"server"`
	DNS               string    `json:"dns"`
	Since             time.Time `json:"since"`
	LastHealthCheck   time.Time `json:"lastHealthCheck"`
	LastHealthCheckOK bool      `json:"lastHealthCheckOk"`
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func (d Deps) handleStatus(w http.ResponseWriter, r *http.Request) {
	s, err := state.Load(d.StatePath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, statusResponse{
		Connected:         s.Connected,
		Country:           s.Country,
		ResolvedCountry:   s.ResolvedCountry,
		City:              s.City,
		ResolvedCity:      s.ResolvedCity,
		Group:             s.Group,
		PublicIP:          s.PublicIP,
		Server:            s.Server,
		DNS:               s.DNS,
		Since:             s.Since,
		LastHealthCheck:   s.LastHealthCheck,
		LastHealthCheckOK: s.LastHealthCheckOK,
	})
}

func (d Deps) handleServers(w http.ResponseWriter, r *http.Request) {
	countries, err := d.Provider.ListCountries(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, countries)
}

func (d Deps) handleCities(w http.ResponseWriter, r *http.Request) {
	lister, ok := d.Provider.(provider.CityLister)
	if !ok {
		writeError(w, http.StatusNotFound, fmt.Errorf("city selection not supported by this provider"))
		return
	}
	cities, err := lister.ListCities(r.Context(), r.URL.Query().Get("country"))
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, cities)
}

func (d Deps) handleGroups(w http.ResponseWriter, r *http.Request) {
	lister, ok := d.Provider.(provider.GroupLister)
	if !ok {
		writeError(w, http.StatusNotFound, fmt.Errorf("server-group selection not supported by this provider"))
		return
	}
	groups, err := lister.ListGroups(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, groups)
}

type connectRequest struct {
	Country string `json:"country"`
	City    string `json:"city"`
	Group   string `json:"group"`
}

// handleConnect re-runs the "pick server -> fetch peer info -> rewrite
// wg0.conf -> wg-quick down/up" flow for the requested country and
// persists the choice so it survives a reboot -- the same recovery path
// selfheal.RunOnce triggers automatically on a failed health check.
func (d Deps) handleConnect(w http.ResponseWriter, r *http.Request) {
	var req connectRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	peer, err := d.Provider.Connect(r.Context(), d.PrivateKey, provider.ServerSelection{Country: req.Country, City: req.City, Group: req.Group})
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	d.WG.Down() // best-effort -- ignored the same way a fresh-boot's first-ever connect (nothing to tear down yet) is
	if err := d.WG.Up(peer); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	publicIP := ""
	if tunnelIP, _, err := net.ParseCIDR(peer.Address); err == nil {
		publicIP = d.resolvePublicIP(r.Context(), tunnelIP.String())
	}

	now := d.now()
	newState := state.State{
		Connected: true,
		// Country is the requested value, not peer.Country (the resolved
		// value): same rationale as City below -- an unreliable/absent
		// upstream field must never be the sole source of truth for what
		// gets persisted and reused on the next self-heal reconnect.
		// peer.Country goes into ResolvedCountry instead, below, rather
		// than being discarded.
		Country:         req.Country,
		ResolvedCountry: peer.Country,
		// City is the requested value, not peer.City (the resolved value --
		// VERIFY LIVE, NordVPN may not actually return it): same rationale
		// as Group below -- an unreliable/absent upstream field must never
		// be the sole source of truth for what gets persisted and reused on
		// the next self-heal reconnect. peer.City goes into ResolvedCity
		// instead, below, rather than being discarded -- it's a live
		// observation of what actually got connected to, not a substitute
		// for the requested value.
		City:              req.City,
		ResolvedCity:      peer.City,
		Group:             req.Group,
		PublicIP:          publicIP,
		Server:            peer.Server,
		DNS:               joinDNS(peer.DNS),
		Since:             now,
		LastHealthCheck:   now,
		LastHealthCheckOK: true,
	}
	if err := state.Save(d.StatePath, newState); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, statusResponse{
		Connected: newState.Connected, Country: newState.Country, ResolvedCountry: newState.ResolvedCountry,
		City: newState.City, ResolvedCity: newState.ResolvedCity, Group: newState.Group,
		PublicIP: newState.PublicIP, Server: newState.Server, DNS: newState.DNS, Since: newState.Since,
		LastHealthCheck: newState.LastHealthCheck, LastHealthCheckOK: newState.LastHealthCheckOK,
	})
}

func joinDNS(dns []string) string {
	if len(dns) == 0 {
		return ""
	}
	return dns[0]
}

var _ WireguardManager = (*wireguard.Manager)(nil)
