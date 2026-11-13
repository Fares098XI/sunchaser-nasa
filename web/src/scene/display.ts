/**
 * One "camera" for every custom shader: linear HDR in, ACES filmic tone curve (Narkowicz 2015 fit), sRGB out.
 * Renderer tone mapping stays off (Canvas `flat`), so terrain, Moon, Earth and sky share this response.
 */
export const DISPLAY_GLSL = /* glsl */ `
  vec3 acesFit(vec3 x) {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
  }
  vec3 toSrgb(vec3 c) {
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  }
  vec3 display(vec3 hdr) { return toSrgb(acesFit(hdr)); }

  // Auto-exposure for sunlit ground: tuned for the pole's grazing Sun (no change up to ~8 deg); a higher Sun (pins
  // anywhere on the Moon, S5b) is exposed down like a camera would, so flat ground does not burn out to white.
  float exposure(float sinSunEl) { return clamp(0.14 / max(sinSunEl, 0.01), 0.2, 1.0); }

  // Every ground shader's response (terrain, near ground, far field): lit = share of the Sun reaching the point.
  // Airless Moon: shadows are black (only earthshine, where Earth is up); grazing light is compressed like a camera
  // exposed for the lit ground, and the gain keeps regolith grey rather than white. Display only: no number reads it.
  vec3 regolith(vec3 albedo, float ll, float lit, float sinSunEl, vec3 eshine) {
    float sun = lit * pow(max(ll, 0.0), 0.6);
    return albedo * (vec3(1.0, 0.97, 0.92) * exposure(sinSunEl) * sun + eshine + 0.01);
  }

  // Lunar-Lambert reflectance (McEwen 1991; coefficients as in USGS ISIS LunarLambertMcEwen):
  // r = 2 L(g) mu0 / (mu0 + mu) + (1 - L(g)) mu0, g = phase angle in degrees.
  float lunarLambert(float mu0, float mu, float gDeg) {
    if (mu0 <= 0.0) return 0.0;
    float L = 1.0 + gDeg * (-0.019 + gDeg * (0.000242 - 0.00000146 * gDeg));
    return 2.0 * L * mu0 / (mu0 + max(mu, 0.0) + 1e-4) + (1.0 - L) * mu0;
  }
`;

/** Scene distances (km): sky objects sit beyond the 150 km far-field terrain, inside the camera's far plane. */
export const SKY_KM = 3000;
export const STAR_KM = 4000;
