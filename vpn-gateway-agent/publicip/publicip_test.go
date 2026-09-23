package publicip

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestResolvePublicIPParsesTrimmedBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("203.0.113.42\n"))
	}))
	defer server.Close()

	ip, err := ResolvePublicIP(context.Background(), http.DefaultClient, server.URL)
	if err != nil {
		t.Fatalf("ResolvePublicIP: %v", err)
	}
	if ip != "203.0.113.42" {
		t.Fatalf("got %q, want 203.0.113.42", ip)
	}
}

func TestResolvePublicIPFailsOnNonOKStatus(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()

	if _, err := ResolvePublicIP(context.Background(), http.DefaultClient, server.URL); err == nil {
		t.Fatal("expected an error for a non-200 response, got nil")
	}
}

func TestNewTunnelClientSourcesRequestsFromGivenLocalAddress(t *testing.T) {
	var gotRemoteAddr string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotRemoteAddr = r.RemoteAddr
		w.Write([]byte("ok"))
	}))
	defer server.Close()

	// 127.0.0.2 (not .1) proves NewTunnelClient's LocalAddr binding is
	// actually applied -- if it silently used the default local address
	// instead, the server would see 127.0.0.1, not 127.0.0.2, and this
	// test would catch that regression (unlike binding to 127.0.0.1
	// itself, which the OS would default to anyway and wouldn't prove
	// anything).
	client := NewTunnelClient("127.0.0.2")
	if _, err := ResolvePublicIP(context.Background(), client, server.URL); err != nil {
		t.Fatalf("ResolvePublicIP: %v", err)
	}
	host, _, err := net.SplitHostPort(gotRemoteAddr)
	if err != nil {
		t.Fatalf("SplitHostPort(%q): %v", gotRemoteAddr, err)
	}
	if host != "127.0.0.2" {
		t.Fatalf("server saw connection from %q, want 127.0.0.2 (NewTunnelClient's LocalAddr binding)", host)
	}
}
