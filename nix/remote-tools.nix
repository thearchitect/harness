# The agents' tools in a remote image (nix/remote-image.nix), the libraries
# nix-ld offers prebuilt binaries, and a check that every tool runs.
pkgs:
let
  tools = with pkgs; [
    gh
    glab
    go
    rustc
    cargo
    clippy
    rustfmt
    zig
    gcc
    gnumake
    pkg-config
    (python3.withPackages (ps: [
      ps.pydicom
      ps.numpy
      ps.pillow
    ]))
    uv
    nodejs
    ffmpeg-headless
    imagemagick
    exiftool
    dcmtk
    zip
    unzip
    file
    ripgrep
    xz
    mise
  ];

  # As the NixOS nix-ld module offers them, without systemd.
  nixLdLibraries = with pkgs; [
    stdenv.cc.cc
    zlib
    zstd
    openssl
    curl
    bzip2
    xz
    libxml2
    libsodium
    acl
    attr
    util-linux
    libssh
  ];
in
{
  inherit tools nixLdLibraries;

  # Every tool answers, Python has its DICOM stack, and a binary built for a
  # plain Linux (the interpreter at /lib64) runs through nix-ld.
  check = pkgs.runCommand "remote-tools-check" { nativeBuildInputs = tools ++ [ pkgs.patchelf ]; } ''
    export HOME=$TMPDIR
    gh --version && glab --version && go version && rustc --version && cargo --version
    zig version && gcc --version && make --version && pkg-config --version
    python3 -c 'import pydicom, numpy, PIL; print(pydicom.__version__)'
    uv --version && node --version && ffmpeg -version && magick -version && exiftool -ver
    dcmdump --version && zip -v && unzip -v && file --version && rg --version && xz --version
    mise --version

    # coreutils (a multi-call binary: named ls) without its Nix interpreter and rpath
    cp ${pkgs.coreutils}/bin/coreutils ls
    chmod u+w ls
    patchelf --set-interpreter /lib64/ld-linux-x86-64.so.2 --remove-rpath ls
    NIX_LD=${pkgs.stdenv.cc.bintools.dynamicLinker} \
    NIX_LD_LIBRARY_PATH=${pkgs.lib.makeLibraryPath (nixLdLibraries ++ [ pkgs.gmp ])} \
      ${pkgs.nix-ld}/libexec/nix-ld ./ls --version
    touch $out
  '';
}
