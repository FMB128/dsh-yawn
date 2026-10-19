{{- /* Standard chart helpers, plus the install guard.

The chart owns the control plane only. The sandbox pool is a separate kustomize
base (`deploy/kubernetes/runner`), which cannot know a release name, so the
names its manifest reads are fixed: the tunnel Service `dsh-yawn-control-plane-tunnel`, the
ConfigMap `dsh-yawn-runner-config`, and the Secret `dsh-yawn-registration-token`.
That is also why the release is pinned to `dsh-yawn-control-plane`: one control
plane per namespace owns those names, and a second release would collide with
the first. The Secret is created and kept current by the control plane itself,
not by this chart.
*/}}

{{- define "dsh-yawn.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "dsh-yawn.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := include "dsh-yawn.name" . }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "dsh-yawn.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* The label the pool's NetworkPolicy selects to allow the
tunnel: the control-plane pod must carry exactly this, so it is fixed rather than
derived from the chart name. */}}
{{- define "dsh-yawn.selectorLabels" -}}
app.kubernetes.io/name: dsh-yawn-control-plane
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "dsh-yawn.labels" -}}
helm.sh/chart: {{ include "dsh-yawn.chart" . }}
{{ include "dsh-yawn.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/* The in-cluster tunnel address sandbox runners dial. Overridable for an
unusual namespace layout, but the default is what the shared runner manifest
expects. */}}
{{- define "dsh-yawn.tunnelUrl" -}}
{{- .Values.runner.controlPlaneUrl | default (printf "ws://dsh-yawn-control-plane-tunnel.%s.svc.cluster.local:8081/tunnel" .Release.Namespace) }}
{{- end }}

{{/* The deployment's sandbox-manager settings, rendered as one ordinary file
mounted at /etc/dsh-yawn/sandbox-settings.yaml. It is a base, not a patch
layer: dsh 0.1.7 lets a home patch outrank the profile patch the Web page
writes to, and the page could then neither save nor reset a deployment
profile. The runtime slice sits under the document's top-level
`sandboxManager` section; startup settings stay in the profile patch.

The section is the chart-to-image contract, and the image tag can differ from
the chart's, so a future version can add a second section without breaking
this one. It is not a general settings layer for other dsh plugins.

A Kubernetes profile that names no namespace is rendered with the release
namespace: the control plane's own default for that field is the fixed name
`dsh-yawn`, which points at the wrong namespace wherever else the chart is
installed. */}}
{{- define "dsh-yawn.sandboxSettings" -}}
{{- $managed := deepCopy .Values.controlPlane.sandboxManager -}}
{{- with $managed.profiles -}}
{{- range $name, $profile := . -}}
{{- if and (eq $profile.backend "kas") (not $profile.namespace) -}}
{{- $_ := set $profile "namespace" $.Release.Namespace -}}
{{- end -}}
{{- end -}}
{{- end -}}
sandboxManager:
{{ pick $managed "profiles" "defaultProfile" "idleMs" "expiresAfterMs" "readyTimeoutMs" | toYaml | indent 2 }}
{{- end }}

{{/* Fails the render on combinations that cannot work, so `helm install`
cannot produce a control plane that never becomes Ready. */}}
{{- define "dsh-yawn.validate" -}}
{{- $root := . -}}
{{- if ne .Release.Name "dsh-yawn-control-plane" -}}
{{- fail (printf "install this chart as release `dsh-yawn-control-plane`: the sandbox pool reads the fixed names dsh-yawn-control-plane-tunnel, dsh-yawn-runner-config, and dsh-yawn-registration-token. Got %q." .Release.Name) }}
{{- end -}}
{{- $managed := .Values.controlPlane.sandboxManager }}
{{- if and $managed (not $managed.profiles) -}}
{{- fail "controlPlane.sandboxManager needs at least one profile; the control plane rejects an empty profile map at runtime." }}
{{- end -}}
{{- $runtimeKeys := list "profiles" "defaultProfile" "idleMs" "expiresAfterMs" "readyTimeoutMs" }}
{{- range $key, $_ := $managed }}
{{- if not (has $key $runtimeKeys) }}
{{- fail (printf "controlPlane.sandboxManager.%s is not a runtime setting; the chart carries profiles, defaultProfile, idleMs, expiresAfterMs, and readyTimeoutMs. Put startup settings in the profile's cordis.patch.yml." $key) }}
{{- end }}
{{- end }}
{{- if and $managed $managed.profiles -}}
{{- /* The pool manifests own the warm pools, so the chart cannot check that a
pool exists; what it can check is that a Kubernetes profile targets the
namespace its own Role and tunnel Service live in. */}}
{{- range $name, $profile := $managed.profiles }}
{{- if eq $profile.backend "kas" }}
{{- $ns := $profile.namespace | default $root.Release.Namespace }}
{{- if ne $ns $root.Release.Namespace -}}
{{- fail (printf "controlPlane.sandboxManager.profiles.%s targets namespace %q but the chart installs into %q; Kubernetes profiles must target the release namespace, where the control plane's Role and the tunnel Service live." $name $ns $root.Release.Namespace) }}
{{- end }}
{{- end }}
{{- end }}
{{- end -}}
{{- if and .Values.oidc.enabled (not .Values.oidc.hostname) -}}
{{- fail "oidc.hostname is required when oidc.enabled is true: it is handed to dsh as --trusted-host and used in the proxy redirect URL." }}
{{- end -}}
{{- if and .Values.oidc.enabled (or .Values.auth.passcode .Values.auth.existingSecret .Values.auth.hostname) -}}
{{- fail "oidc.enabled uses the proxy for sign-in; leave auth.passcode, auth.existingSecret, and auth.hostname empty (use oidc.hostname)." }}
{{- end -}}
{{- if and .Values.controlPlane.launchToken (or .Values.auth.passcode .Values.auth.existingSecret .Values.auth.hostname) -}}
{{- fail "controlPlane.launchToken is break-glass only and cannot be combined with auth.passcode, auth.existingSecret, or auth.hostname." }}
{{- end -}}
{{- if and .Values.oidc.enabled .Values.controlPlane.launchToken -}}
{{- fail "oidc.enabled already mounts /launch-token for the proxy handoff; leave controlPlane.launchToken false." }}
{{- end -}}
{{- $passcodeMode := and (not .Values.oidc.enabled) (not .Values.controlPlane.launchToken) -}}
{{- if $passcodeMode -}}
{{- if and .Values.auth.passcode .Values.auth.existingSecret -}}
{{- fail "set either auth.passcode or auth.existingSecret, not both." }}
{{- end -}}
{{- if not (or .Values.auth.passcode .Values.auth.existingSecret) -}}
{{- fail "set auth.passcode or auth.existingSecret for the passcode login, or enable oidc. controlPlane.launchToken is break-glass only." }}
{{- end -}}
{{- if and .Values.auth.passcode (lt (len .Values.auth.passcode) 8) -}}
{{- fail "auth.passcode must be at least 8 characters." }}
{{- end -}}
{{- if and .Values.auth.existingSecret (not .Values.auth.secretKey) -}}
{{- fail "auth.secretKey is required with auth.existingSecret." }}
{{- end -}}
{{- end -}}
{{- if and (ne .Values.service.type "ClusterIP") (not .Values.oidc.enabled) (not $passcodeMode) -}}
{{- fail "service.type only exposes the oauth2-proxy or the passcode listener. Enable oidc, set auth.passcode, or keep service.type ClusterIP with controlPlane.launchToken." }}
{{- end -}}
{{- if and $passcodeMode (ne .Values.service.type "ClusterIP") (not .Values.auth.hostname) -}}
{{- fail "auth.hostname is required when service.type exposes the passcode listener: it is handed to dsh as --trusted-host so the browser's Host passes dsh's request fence." }}
{{- end -}}
{{- end -}}
