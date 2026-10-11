#!/bin/sh
# Install Chrome for Testing, the libraries it links against, and a font, into
# a sandbox on demand.
#
# The runner image carries this script and the `agent-browser` CLI but not the
# browser: Chrome and its dependencies are far larger than the rest of the
# image put together, and a sandbox needs them only when a task actually drives
# a page. This pays that cost once per sandbox, into the workspace volume so a
# hibernation keeps it.
#
# It does not use the sandbox's sudo. The libraries have to live under $HOME to
# survive a wake, and `apt-get` would put them in the container filesystem
# instead, so the packages are fetched with a user-owned apt state, unpacked
# into a private directory, and reached through LD_LIBRARY_PATH. apt resolves
# whatever they pull in; the list is a starting point, not a hand-maintained
# inventory.
#
# The font is not optional: a slim Debian ships none, and without one Chrome
# draws no text at all, so a page renders blank and the browser can exit on its
# first navigation.
#
# Usage:  install-browser
# Then:   . "$HOME/.local/share/agent-browser-env.sh"
#
# Re-running is cheap and safe: an existing browser and library tree are left
# alone unless AGENT_BROWSER_REINSTALL=1 is set.

set -eu

: "${HOME:?HOME must be set}"

# Debian release and architecture decide the package URLs. The runner is
# always Debian, so this reads the release the image already carries.
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
fi
release="${VERSION_CODENAME:-trixie}"
case "$(dpkg --print-architecture)" in
  amd64) deb_arch=amd64; multiarch=x86_64-linux-gnu ;;
  arm64) deb_arch=arm64; multiarch=aarch64-linux-gnu ;;
  *)
    echo "install-browser: unsupported architecture: $(dpkg --print-architecture)" >&2
    exit 1
    ;;
esac

browser_root="$HOME/.agent-browser"
lib_root="$HOME/.agent-browser-libs"
font_root="$HOME/.local/share/fonts"
env_file="$HOME/.local/share/agent-browser-env.sh"

# The browser the CLI would download, and a marker for the library tree and
# the fonts, so a tree installed before fonts were part of this is completed
# rather than skipped.
existing_browser="$(find "$browser_root/browsers" -type f -name chrome -print -quit 2>/dev/null || true)"
existing_font="$(find "$font_root" -type f -name '*.ttf' -print -quit 2>/dev/null || true)"

if [ "${AGENT_BROWSER_REINSTALL:-0}" != "1" ] && [ -n "$existing_browser" ] && [ -d "$lib_root/usr/lib" ] && [ -n "$existing_font" ]; then
  echo "install-browser: already installed at $existing_browser"
else
  # --- Shared libraries ---------------------------------------------------
  #
  # Chrome links against a set of libraries a slim Debian does not carry.
  # `agent-browser install --with-deps` would ask `sudo apt-get` for them, which
  # puts them in the container filesystem where a wake does not keep them.
  # Instead, point apt at a state directory this user owns, ask it to resolve and
  # download the same packages without installing them, and unpack each into
  # $lib_root.
  #
  # The sources use HTTPS because plain HTTP is commonly blocked from a
  # sandbox while HTTPS egress is allowed.
  apt_root="$(mktemp -d)"
  trap 'rm -rf "$apt_root"' EXIT
  mkdir -p "$apt_root/lists/partial" "$apt_root/archives/partial" "$apt_root/etc"
  : > "$apt_root/status"

  cat > "$apt_root/sources.list" <<EOF
deb [arch=$deb_arch] https://deb.debian.org/debian $release main
EOF

  cat > "$apt_root/apt.conf" <<EOF
Dir::State "$apt_root/lists";
Dir::State::status "$apt_root/status";
Dir::Cache "$apt_root";
Dir::Cache::archives "$apt_root/archives";
Dir::Etc::sourcelist "$apt_root/sources.list";
Dir::Etc::sourceparts "$apt_root/empty";
Dir::Etc::trusted "/etc/apt/trusted.gpg";
Dir::Etc::trustedparts "/etc/apt/trusted.gpg.d";
EOF
  mkdir -p "$apt_root/empty"

  echo "install-browser: fetching package lists"
  apt-get -c "$apt_root/apt.conf" update -qq

  # Chrome's own list, kept in step with the browser the CLI installs, plus
  # the font below. apt resolves whatever these pull in, so this is a starting
  # point rather than a complete inventory.
  echo "install-browser: resolving Chrome's libraries and a font"
  apt-get -y -c "$apt_root/apt.conf" --download-only --no-install-recommends install \
    libxcb-shm0 libx11-xcb1 libx11-6 libxcb1 libxext6 libxrandr2 \
    libxcomposite1 libxcursor1 libxdamage1 libxfixes3 libxi6 \
    libgtk-3-0t64 libpangocairo-1.0-0 libpango-1.0-0 \
    libatk1.0-0t64 libcairo-gobject2 libcairo2 \
    libgdk-pixbuf-2.0-0 libxrender1 libasound2t64 libfreetype6 \
    libfontconfig1 libdbus-1-3 libnss3 libnss3-tools libnspr4 \
    libatk-bridge2.0-0t64 libdrm2 libxkbcommon0 libatspi2.0-0t64 \
    libcups2t64 libxshmfence1 libgbm1 fonts-dejavu-core >/dev/null

  echo "install-browser: unpacking libraries into $lib_root"
  rm -rf "$lib_root"
  mkdir -p "$lib_root"
  for package in "$apt_root"/archives/*.deb; do
    dpkg-deb -x "$package" "$lib_root"
  done

  # fontconfig reads a user's own fonts from here with no configuration, and
  # $HOME is on the workspace volume, so they survive a wake with everything
  # else. Chrome draws no text without one.
  echo "install-browser: installing fonts into $font_root"
  mkdir -p "$font_root"
  find "$lib_root/usr/share/fonts" -type f -name '*.ttf' \
    -exec cp -f {} "$font_root/" \;
  if [ -z "$(find "$font_root" -type f -name '*.ttf' -print -quit)" ]; then
    echo "install-browser: no fonts were unpacked" >&2
    exit 1
  fi

  # --- Browser ------------------------------------------------------------
  echo "install-browser: downloading Chrome for Testing"
  HOME="$HOME" "$(command -v agent-browser)" install
fi

# --- Make it usable -------------------------------------------------------

chrome_bin="$(find "$browser_root/browsers" -type f -name chrome -print -quit 2>/dev/null || true)"
if [ -z "$chrome_bin" ]; then
  echo "install-browser: Chrome was not installed" >&2
  exit 1
fi

# A sandbox blocks unprivileged user namespaces, so Chrome's own sandbox
# cannot start and the browser must run with --no-sandbox. /dev/shm is small
# in a container too, which crashes renderers on real pages unless Chrome is
# told to use /tmp instead. Both are container constraints, and both are why
# this environment is only for a sandbox that is already disposable.
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/google-chrome" <<EOF
#!/bin/sh
# Generated by install-browser.sh: Chrome plus the libraries beside it.
LD_LIBRARY_PATH="$lib_root/usr/lib/${multiarch}:$lib_root/lib/${multiarch}:\${LD_LIBRARY_PATH:-}"
export LD_LIBRARY_PATH
exec "$chrome_bin" --no-sandbox --disable-dev-shm-usage "\$@"
EOF
chmod 0755 "$HOME/.local/bin/google-chrome"

# A login shell resets PATH, and LD_LIBRARY_PATH does not survive between
# tool calls, so both are recorded where a later command can source them.
# The unpacked usr/bin goes last on PATH: it carries certutil, which
# `agent-browser --ca-cert` runs, and must not shadow a system command.
mkdir -p "$(dirname "$env_file")"
cat > "$env_file" <<EOF
# Generated by install-browser.sh. Source before driving the browser:
#   . "$env_file"
export LD_LIBRARY_PATH="$lib_root/usr/lib/${multiarch}:$lib_root/lib/${multiarch}:\${LD_LIBRARY_PATH:-}"
export AGENT_BROWSER_EXECUTABLE_PATH="$HOME/.local/bin/google-chrome"
case ":\$PATH:" in
  *":\$HOME/.local/bin:"*) ;;
  *) PATH="\$HOME/.local/bin:\$PATH" ;;
esac
case ":\$PATH:" in
  *":$lib_root/usr/bin:"*) ;;
  *) PATH="\$PATH:$lib_root/usr/bin" ;;
esac
export PATH
EOF

echo "install-browser: done — Chrome at $chrome_bin"
echo "install-browser: run '. $env_file' before using agent-browser"
