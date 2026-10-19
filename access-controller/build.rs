//! Validates the build-time network configuration (see network.env.example).

fn main() {
    for var in [
        "CONWAY_SSID",
        "CONWAY_PASSWORD",
        "CONWAY_HOST",
        "CONWAY_PORT",
    ] {
        println!("cargo::rerun-if-env-changed={var}");
    }
    let require = |var: &str| {
        std::env::var(var).unwrap_or_else(|_| panic!("{var} must be set; see network.env.example"))
    };
    require("CONWAY_SSID");
    require("CONWAY_PASSWORD");
    require("CONWAY_HOST")
        .parse::<std::net::Ipv4Addr>()
        .expect("CONWAY_HOST must be an IPv4 address");
    let port = std::env::var("CONWAY_PORT").unwrap_or_else(|_| "8080".into());
    port.parse::<u16>()
        .expect("CONWAY_PORT must be a port number");
    println!("cargo::rustc-env=CONWAY_PORT={port}");
}
