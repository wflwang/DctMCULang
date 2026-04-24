;//@@@HXW inst###

#define a   r0
#include "../pad.inc"
//ddd
;
ad10 equ    d87
#define d87 bb3
#define bb3 y38
y38 equ 39+5
ccb equ 33
#define ddd bbb
#define bbb 200
porta equ  0x04|1
#define PIN_333 porta,3
temp    equ     390
setio   equ     0x0|(0<<1)|(0<<2)|(0<<3)
#define setio1   0x0|(0<<1)|(0<<2)|(0<<3)|(1<<4)
cblock  0x10
temp2
temp3
temp4
temp6
temp5
endc
ddx  macro  temp3,temp2
    movia       temp2
    movar       temp3
endm


    ORG 0x1000

    goto       LOOP
ifdef dd
    mov     a,1
    MOV     3
    sb      33,a`
    goto    LOOP
    stt16   
    ldt16
    movia   33
endif
#if 1
LOOP:
    bcr     PIN_333
    movia   ad10
    movia   ddd
    ddx
    movia
    RXROLL1
    movar
    sdf1
    xorar   ad10,0
    xorar   temp4,0
    movar   temp2
    movar   temp3
    movr    temp2,0
    xoria   ad10
    addar   ad10,1
    movia   setio
    movar   0x04
    movia   setio1
    movia   setio
    adcar   ad10,1
    ret
    retia   3
    retie
    subar   add10,0
    sbcar   add10,0
    comr    add10,1
    subar   bbb,0
    movr    ccc,0
    mov     a,1
    mov     a,temp
    MOV     3
    sb      33,a`
    goto    LOOP
    stt16   
    ldt16
    movia   33
#endif
MAIN:
    wdreset
    goto        MAIN_LOOP:
    call        
    call            MAIN
    goto        MAIN
    xch     
    comp    a,3
    ceqsn   d
    wdreset 3
    reset
    nadd    a,33
    add     a,1
    subc        aa
