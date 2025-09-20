import json
from websockets.asyncio.server import broadcast, serve
from websockets.exceptions import ConnectionClosed
from eyetrax import GazeEstimator, run_9_point_calibration
from eyetrax.filters import KalmanSmoother, make_kalman
import cv2
import time
import os
import argparse
import asyncio
import sys
from screeninfo import get_monitors

prs = argparse.ArgumentParser(prog='slopathon')
prs.add_argument('-m', '--model')
args = prs.parse_args()

estimator = GazeEstimator()

if args.model is not None and os.path.exists(args.model):
	estimator.load_model(args.model)
else:
	run_9_point_calibration(estimator)
	# run_lissajous_calibration(estimator)
	estimator.save_model("gaze_model.pk1")
	print("saved model")
	sys.exit(0)

k = make_kalman()
smoother = KalmanSmoother(k)
smoother.tune(estimator, camera_index=0)

cap = cv2.VideoCapture(0)
screen = get_monitors()[0]

def read_gaze():
	ret, frame = cap.read()
	features, blink = estimator.extract_features(frame)

	x, y = 0, 0
	if features is not None and not blink:
		x, y = estimator.predict([features])[0]
		print(f"Gaze: ({x:.0f}, {y:.0f})")

	return {
    	"x": x / screen.width,
    	"y": y / screen.height,
    	"blink": bool(blink),
    }

connections = set()

async def handler(ws):
	try:
		while True:
			payload = json.dumps(read_gaze())
			await ws.send(payload)
			await asyncio.sleep(1/60)
	except ConnectionClosed:
		print("connection closed", ws)

async def main():
	async with serve(handler, "localhost", 8001) as server:
		 await server.serve_forever()

if __name__ == "__main__":
    asyncio.run(main())
