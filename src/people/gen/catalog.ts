/**
 * The creator's categories and pages, as The Sims 4's Create a Sim lays
 * them out: person, body regions, the head part by part (head, eyes, nose,
 * mouth, ears, chin and jaw), skin and eyes, expression. Each page lists the
 * sliders it shows and where the camera goes while it is open.
 *
 * Feature sliders are the Vitruvian's own morphs (`Nose_Potrusion`...); a
 * morph with min -1 is a two-way slider, one with min 0 goes one way.
 * Labels are `hgen.m.<morph>` in the interface dictionaries.
 */

/** Where the camera frames the person. */
export type Focus = 'body' | 'torso' | 'arms' | 'legs' | 'head' | 'eyes' | 'nose' | 'mouth' | 'ears' | 'chin';

export interface CatalogPage {
  readonly id: string;
  /** Interface key of the page's name. */
  readonly label: string;
  readonly focus: Focus;
  /** Feature morphs, in order. */
  readonly morphs: readonly string[];
}

export interface CatalogCategory {
  readonly id: string;
  readonly label: string;
  /** The rail icon's name (see the creator's icon set). */
  readonly icon: string;
  readonly pages: readonly CatalogPage[];
}

const page = (id: string, focus: Focus, morphs: readonly string[] = []): CatalogPage => ({ id, label: `hgen.page.${id}`, focus, morphs });

export const CATALOG: readonly CatalogCategory[] = [
  { id: 'person', label: 'hgen.cat.person', icon: 'person', pages: [page('basics', 'body')] },
  {
    id: 'body', label: 'hgen.cat.body', icon: 'body', pages: [
      page('build', 'body'),
      page('torso', 'torso', ['Shoulders_ShoulderWidth', 'Shoulders_ShoulderBladeWidth', 'Shoulders_ShoulderTrapeziusSize', 'Torso_RibWidth',
        'Chest_Breast_Size', 'Chest_FemaleFlatChested', 'Stomach_Bloating', 'Stomach_BellyButtonPotrusion', 'Waist_Width', 'Waist_Hips_Width', 'Waist_GluteSize']),
      page('arms', 'arms', ['Arms_BicepSize', 'Arms_TricepSize', 'Arms_Forearm_Girth', 'Arms_Armpit_Loc_Z', 'Hands_Size', 'Hands_Girth', 'Hands_FingernailLength', 'Hands_FingernailPointiness']),
      page('legs', 'legs', ['Legs_Thigh_Size', 'Legs_Quad_Size', 'Legs_Hamstring_Size', 'Legs_Thigh_Gap', 'Legs_Calves_Size', 'Legs_FeetSize', 'Legs_FlatFoot', 'Legs_Toenail_Length']),
      page('neck', 'head', ['Neck_Girth', 'Neck_Length', 'Neck_ChinConnection', 'Neck_AdamsApple']),
    ],
  },
  {
    id: 'head', label: 'hgen.cat.head', icon: 'head', pages: [
      page('headShape', 'head', ['Head_TopScalpPotrusion', 'Head_SideScalpPotrusion', 'Head_BackScalpPotrusion', 'Head_ParietalFlatness', 'Head_FrontalBoneFlatness',
        'Head_SphenoidBone', 'Head_TemporalLines', 'Face_FrontalBone', 'Face_FrontalBone_FrontalEminence', 'Face_Puffy']),
      page('cheeks', 'head', ['Cheeks_BoneDefinition', 'Cheeks_CheeksBonePositionZ', 'Cheeks_UpperCheek_Bone', 'Cheeks_BuccalFat', 'Face_Zygomatic_Bone', 'Face_Maxilla']),
      page('faceShape', 'head'),
    ],
  },
  {
    id: 'hair', label: 'hgen.cat.hair', icon: 'hair', pages: [page('hairStyle', 'head'), page('hairColour', 'head'), page('hairShape', 'head')],
  },
  {
    id: 'brows', label: 'hgen.cat.brows', icon: 'brow', pages: [
      page('browHair', 'eyes'),
      page('brow', 'eyes', ['Face_FrontalBone_BrowRidge', 'Face_BrowRidge_Raise', 'Face_BrowRidge_Droop', 'Face_BrowRidge_CurvedRaise', 'Face_BrowRidge_CurvedDroop',
        'Eyes_EyebrowsAngle', 'Eyes_EyebrowsDroop', 'Face_EyeSocket_Potrusion']),
    ],
  },
  {
    id: 'eyes', label: 'hgen.cat.eyes', icon: 'eye', pages: [
      page('eyeColour', 'eyes'),
      page('lashes', 'eyes'),
      page('eyeShape', 'eyes', ['Eyes_Size', 'Eyes_Distance', 'Eyes_VerticalShift', 'Eyes_EyelidsAngle', 'Eyes_EyelidsAngle2', 'Eyes_UpperLidOpenness', 'Eyes_LowerLidOpenness', 'Eyes_EyelidsCrease']),
      page('eyelids', 'eyes', ['Eyes_Eyelid_Monolid', 'Eyes_Eyelid_hooded', 'Eyes_EyeBagsSize', 'Eyes_EyeBagsProminence', 'Eyes_LacrimalCaruncle_Rotate', 'Eyes_LacrimalCaruncle_Sharpness']),
    ],
  },
  {
    id: 'nose', label: 'hgen.cat.nose', icon: 'nose', pages: [
      page('nose', 'nose', ['Nose_NoseHeight', 'Nose_Potrusion', 'Nose_BridgeProminence', 'Nose_NasalBone', 'Nose_NasalAngle', 'Nose_Tip_Potrusion', 'Nose_TipCrease',
        'Nose_BottomFlatness', 'Nose_NostrilSize', 'Nose_NasalBone_AnteriorNasalAperature', 'Nose_NasalBone_AnteriorNasalSpine']),
    ],
  },
  {
    id: 'mouth', label: 'hgen.cat.mouth', icon: 'mouth', pages: [
      page('mouth', 'mouth', ['Mouth_Lips_Length', 'Mouth_Lips_Height', 'Mouth_Lips_UpperLipDepth', 'Mouth_Lips_BottomLipDepth', 'Mouth_Lips_UpperLipArch',
        'Mouth_Lips_UpperAngle', 'Mouth_Lips_LowerAngle', 'Mouth_PhiltrumDepth', 'Mouth_PhiltrumHeight']),
    ],
  },
  {
    id: 'ears', label: 'hgen.cat.ears', icon: 'ear', pages: [
      page('ears', 'ears', ['Ears_Height', 'Ears_Length', 'Ears_Round', 'Ears_Rot', 'Ears_Potrusion', 'Ears_PotrusionTop', 'Ears_Lobe', 'Ears_LobeAttached',
        'Ears_Tragus_Portrusion', 'Ears_Canal_Size', 'Ears_Canal_Depth']),
    ],
  },
  {
    id: 'jaw', label: 'hgen.cat.jaw', icon: 'jaw', pages: [
      page('chin', 'chin', ['Chin_Width', 'Chin_SecondaryWidth', 'Chin_Height', 'Chin_Portrusion', 'Chin_PosZ', 'Chin_Tilt', 'Chin_ChinCleft']),
      page('jaw', 'chin', ['Jaw_Width', 'Jaw_Mandible', 'Jaw_Mandible_GonialAngle', 'Jaw_Definition', 'Jaw_Ramus_Extrusion', 'Jaw_Ramus_LocY']),
    ],
  },
  { id: 'skin', label: 'hgen.cat.skin', icon: 'palette', pages: [page('skin', 'head')] },
  { id: 'makeup', label: 'hgen.cat.makeup', icon: 'lips', pages: [page('makeup', 'mouth')] },
  { id: 'accessories', label: 'hgen.cat.accessories', icon: 'glasses', pages: [page('accessories', 'head')] },
  { id: 'outfit', label: 'hgen.cat.outfit', icon: 'shirt', pages: [page('top', 'torso'), page('bottom', 'legs'), page('shoes', 'legs')] },
  { id: 'expression', label: 'hgen.cat.expression', icon: 'smile', pages: [page('expression', 'head')] },
];

/** The expressions offered as presets (the Vitruvian's FACS-built set). */
export const EXPRESSIONS: readonly string[] = [
  '', 'Smile_Lips_Closed', 'Happy', 'Kiss', 'Thinking', 'Circumspect', 'Oops', 'Sad', 'Angry', 'Disgusted', 'Revulsion', 'Scared',
  'Eyes_Squint', 'Eyes_Closed_Max', 'Mouth_Large_Opened', 'Cheeks_Puffed',
];
