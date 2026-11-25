// a separate Cargo workspace two directories deep: found only through linkedProjects
fn banner() -> &'static str {
    "cli"
}

fn main() {
    println!("{}", banner());
}
