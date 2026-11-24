(*
 * Conveyor sorter - cyclic task
 * Sorts parts by colour: red -> bin A, blue -> bin B, green -> end of belt.
 *
 * Parts are tracked with the belt encoder: when a part passes the colour
 * sensor we store "encoder now + distance to its pusher" in a ring buffer.
 * When the encoder reaches that value, the part is in front of the pusher.
 *)
PROGRAM _CYCLIC

	(* ---------- 1. Emergency stop: highest priority, latches FAULT ---------- *)
	IF diEStop THEN
		State := STATE_FAULT;
		RedCount := 0;  RedHead := 0;
		BlueCount := 0; BlueHead := 0;
		RedPush.IN := FALSE;
		BluePush.IN := FALSE;
	END_IF;

	(* ---------- 2. State machine ---------- *)
	CASE State OF
		STATE_IDLE:
			IF diStart AND NOT diStop THEN
				State := STATE_RUNNING;
			END_IF;

		STATE_RUNNING:
			IF diStop THEN
				State := STATE_IDLE;
			END_IF;

		STATE_FAULT:
			IF NOT diEStop AND diReset THEN
				State := STATE_IDLE;
			END_IF;
	END_CASE;

	(* ---------- 3. Tracking: remember each part at the colour sensor ---------- *)
	SensorEdge(CLK := diPartAtSensor);

	IF State = STATE_RUNNING AND SensorEdge.Q THEN
		IF diColourRed THEN
			IF RedCount < QUEUE_SIZE THEN
				RedQueue[(RedHead + RedCount) MOD QUEUE_SIZE] := aiEncoder + RED_OFFSET;
				RedCount := RedCount + 1;
			ELSE
				DroppedParts := DroppedParts + 1;
			END_IF;
		ELSIF diColourBlue THEN
			IF BlueCount < QUEUE_SIZE THEN
				BlueQueue[(BlueHead + BlueCount) MOD QUEUE_SIZE] := aiEncoder + BLUE_OFFSET;
				BlueCount := BlueCount + 1;
			ELSE
				DroppedParts := DroppedParts + 1;
			END_IF;
		ELSE
			GreenParts := GreenParts + 1;  (* green rides to the end of the belt *)
		END_IF;
	END_IF;

	(* ---------- 4. Fire a pusher when its part arrives ---------- *)
	IF State <> STATE_FAULT AND NOT RedPush.IN AND RedCount > 0 THEN
		IF aiEncoder >= RedQueue[RedHead] THEN
			RedHead := (RedHead + 1) MOD QUEUE_SIZE;
			RedCount := RedCount - 1;
			RedPush.IN := TRUE;
			RedParts := RedParts + 1;
		END_IF;
	END_IF;

	IF State <> STATE_FAULT AND NOT BluePush.IN AND BlueCount > 0 THEN
		IF aiEncoder >= BlueQueue[BlueHead] THEN
			BlueHead := (BlueHead + 1) MOD QUEUE_SIZE;
			BlueCount := BlueCount - 1;
			BluePush.IN := TRUE;
			BlueParts := BlueParts + 1;
		END_IF;
	END_IF;

	RedPush(PT := PUSH_TIME);
	BluePush(PT := PUSH_TIME);
	IF RedPush.Q THEN
		RedPush.IN := FALSE;
	END_IF;
	IF BluePush.Q THEN
		BluePush.IN := FALSE;
	END_IF;

	(* ---------- 5. Outputs ---------- *)
	doMotor     := State = STATE_RUNNING;
	doPushRed   := RedPush.IN;
	doPushBlue  := BluePush.IN;
	doLampRun   := State = STATE_RUNNING;
	doLampFault := State = STATE_FAULT;

END_PROGRAM
