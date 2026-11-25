mod util;

pub fn compute(value: u32) -> u32 {
    util::double(value)
}

#[cfg(feature = "extra")]
pub fn extra() -> u32 {
    compute(1)
}
