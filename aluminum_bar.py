# Aluminium bar: 100 x 50 x 5 mm, R5 rounded corners, 10 mm center through-hole.
# Origin: center of bar; XY base plane; +Z = thickness direction.
from build123d import (
    BuildPart, BuildSketch, RectangleRounded, Circle,
    Extrude, Mode
)


def gen_step():
    length = 100.0
    width  = 50.0
    thick  = 5.0
    corner = 5.0
    hole_d = 10.0

    with BuildPart() as part:
        with BuildSketch():
            RectangleRounded(length, width, corner)
            Circle(hole_d / 2, mode=Mode.SUBTRACT)
        Extrude(amount=thick)

    part.label = "aluminum_bar"
    return part.part
